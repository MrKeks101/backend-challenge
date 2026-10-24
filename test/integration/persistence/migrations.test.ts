import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ALL_TABLES } from "../../../src/database/orm";
import { columnTypeSql } from "../../../src/shared/infrastructure/persistence/table-def";
import { createTestDatabase, type TestDatabase } from "../../support/database";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase({ migrate: false });
});
afterAll(async () => {
  await db.close();
});

const tables = async (): Promise<string[]> =>
  (
    await db.sql<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name NOT LIKE 'mikro_orm%' ORDER BY table_name`,
    )
  ).map((r) => r.table_name);

const routines = async (): Promise<string[]> =>
  (
    await db.sql<{ proname: string }[]>(
      `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' ORDER BY proname`,
    )
  ).map((r) => r.proname);

describe("migrations (SQL à mão, reversíveis)", () => {
  const EXPECTED = [
    "inbox_messages",
    "outbox_messages",
    "wager_transactions",
    "wallet_ledger_entries",
    "wallets",
  ];

  test("banco novo não tem tabelas do sistema", async () => {
    expect(await tables()).toEqual([]);
  });

  test("up cria tabelas e funções; down remove tudo; up de novo recria (up → down → up)", async () => {
    await db.orm.migrator.up();
    expect(await tables()).toEqual(EXPECTED);
    expect(await routines()).toEqual(["assert_wallet_matches_ledger", "forbid_mutation"]);

    await db.orm.migrator.down({ to: 0 });
    expect(await tables()).toEqual([]);
    expect(await routines()).toEqual([]);

    await db.orm.migrator.up();
    expect(await tables()).toEqual(EXPECTED);
  });

  test("up é idempotente: uma segunda execução não tem nada a aplicar", async () => {
    expect(await db.orm.migrator.getPending()).toHaveLength(0);
    await db.orm.migrator.up();
    expect(await tables()).toEqual(EXPECTED);
  });

  test("down de uma migration por vez desfaz na ordem inversa", async () => {
    await db.orm.migrator.down(); // triggers
    expect(await routines()).toEqual([]);
    expect(await tables()).toEqual(EXPECTED);
    await db.orm.migrator.down(); // tabelas
    expect(await tables()).toEqual([]);
    await db.orm.migrator.up();
  });
});

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_identity: string;
}

/** Tipo "como o descritor declara" → o que `information_schema` reporta. */
const DATA_TYPE: Record<string, string> = {
  uuid: "uuid",
  text: "text",
  char: "character",
  numeric: "numeric",
  timestamptz: "timestamp with time zone",
  integer: "integer",
  bigint: "bigint",
  jsonb: "jsonb",
};

describe("divergência EntitySchema × banco real (mitiga o contra do SQL à mão, D15)", () => {
  for (const table of ALL_TABLES) {
    describe(table.name, () => {
      let actual: ColumnInfo[];
      beforeAll(async () => {
        actual = await db.sql<ColumnInfo[]>(
          `SELECT column_name, data_type, is_nullable, character_maximum_length,
                  numeric_precision, numeric_scale, is_identity
           FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?`,
          [table.name],
        );
      });

      test("o conjunto de colunas é exatamente o declarado (nem a mais, nem a menos)", () => {
        const declared = Object.values(table.columns)
          .map((c) => c.column)
          .sort();
        expect(actual.map((c) => c.column_name).sort()).toEqual(declared);
      });

      for (const [prop, col] of Object.entries(table.columns)) {
        test(`${prop} → ${col.column}: ${columnTypeSql(col)}${col.nullable ? " null" : " not null"}`, () => {
          const real = actual.find((c) => c.column_name === col.column);
          expect(real).toBeDefined();
          expect(real?.data_type).toBe(DATA_TYPE[col.type] as string);
          expect(real?.is_nullable).toBe(col.nullable ? "YES" : "NO");
          if (col.type === "char") expect(real?.character_maximum_length).toBe(col.length ?? -1);
          if (col.type === "numeric") {
            expect(real?.numeric_precision).toBe(col.precision ?? -1);
            expect(real?.numeric_scale).toBe(col.scale ?? -1);
          }
          expect(real?.is_identity === "YES").toBe(col.generated === true);
        });
      }
    });
  }

  test("o ORM descobre o mesmo mapeamento (tabela, coluna e tipo de cada propriedade)", () => {
    const metadata = db.orm.getMetadata();
    for (const table of ALL_TABLES) {
      const meta = metadata.get(table.entityName as never);
      expect(meta.tableName).toBe(table.name);
      for (const [prop, col] of Object.entries(table.columns)) {
        const p = meta.properties[prop];
        expect(p?.fieldNames).toEqual([col.column]);
        expect(p?.columnTypes).toEqual([columnTypeSql(col)]);
        expect(p?.nullable ?? false).toBe(col.nullable ?? false);
      }
    }
  });
});
