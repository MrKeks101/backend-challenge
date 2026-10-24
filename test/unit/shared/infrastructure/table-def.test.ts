import { describe, expect, test } from "bun:test";
import {
  coerceRecord,
  columnTypeSql,
  defineTable,
  insertStatement,
  money,
  parseTimestamptz,
  selectList,
  toEntitySchema,
} from "../../../../src/shared/infrastructure/persistence/table-def";

const table = defineTable("things", "ThingRecord", {
  id: { column: "id", type: "uuid", primary: true },
  seq: { column: "seq", type: "bigint", generated: true },
  ownerName: { column: "owner_name", type: "text" },
  code: { column: "code", type: "char", length: 3 },
  total: money("total"),
  note: { column: "note", type: "text", nullable: true },
  payload: { column: "payload", type: "jsonb" },
  createdAt: { column: "created_at", type: "timestamptz" },
  closedAt: { column: "closed_at", type: "timestamptz", nullable: true },
});

describe("selectList", () => {
  test("aliasa cada coluna para a propriedade, entre aspas", () => {
    expect(selectList(table)).toBe(
      [
        '"id" AS "id"',
        '"seq" AS "seq"',
        '"owner_name" AS "ownerName"',
        '"code" AS "code"',
        '"total" AS "total"',
        '"note" AS "note"',
        '"payload" AS "payload"',
        '"created_at" AS "createdAt"',
        '"closed_at" AS "closedAt"',
      ].join(", "),
    );
  });

  test("aceita prefixo de alias de tabela", () => {
    expect(selectList(table, "t").startsWith('t."id" AS "id", t."seq"')).toBe(true);
  });
});

describe("insertStatement", () => {
  const record = {
    id: "u",
    ownerName: "x",
    code: "BRL",
    total: "1.00",
    payload: { a: 1 },
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  test("omite colunas geradas, usa ? e serializa jsonb com cast", () => {
    const { sql, params } = insertStatement(table, record);
    expect(sql).toBe(
      'INSERT INTO "things" ("id", "owner_name", "code", "total", "note", "payload", "created_at", "closed_at") VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?)',
    );
    expect(params).toEqual(["u", "x", "BRL", "1.00", null, '{"a":1}', record.createdAt, null]);
  });

  test("undefined vira NULL", () => {
    expect(insertStatement(table, { ...record, note: undefined }).params[4]).toBeNull();
  });

  test("ON CONFLICT DO NOTHING com alvo e RETURNING", () => {
    const { sql } = insertStatement(table, record, {
      onConflictDoNothing: "(id)",
      returning: '"id"',
    });
    expect(sql.endsWith('ON CONFLICT (id) DO NOTHING RETURNING "id"')).toBe(true);
  });

  test("ON CONFLICT sem alvo vale para qualquer unique", () => {
    const { sql } = insertStatement(table, record, { onConflictDoNothing: "" });
    expect(sql).toContain("ON CONFLICT  DO NOTHING");
  });

  test("valores NUNCA entram no texto do SQL (só como parâmetros)", () => {
    const { sql } = insertStatement(table, { ...record, ownerName: "'; DROP TABLE things; --" });
    expect(sql).not.toContain("DROP");
  });

  test("identificadores com aspas são escapados", () => {
    const odd = defineTable('we"ird', "Odd", { a: { column: 'c"1', type: "text" } });
    expect(insertStatement(odd, { a: "x" }).sql).toBe('INSERT INTO "we""ird" ("c""1") VALUES (?)');
  });
});

describe("columnTypeSql", () => {
  test("descreve char(n) e numeric(p,s); demais tipos pelo nome", () => {
    expect(columnTypeSql({ column: "c", type: "char", length: 64 })).toBe("char(64)");
    expect(columnTypeSql(money("m"))).toBe("numeric(19,2)");
    expect(columnTypeSql({ column: "c", type: "timestamptz" })).toBe("timestamptz");
    expect(columnTypeSql({ column: "c", type: "uuid" })).toBe("uuid");
  });
});

describe("parseTimestamptz", () => {
  test.each([
    ["2026-10-24 05:09:10.663757+00", "2026-10-24T05:09:10.663Z"],
    ["2026-10-24 05:09:10+00", "2026-10-24T05:09:10.000Z"],
    ["2026-10-24 05:09:10.5+00", "2026-10-24T05:09:10.500Z"],
    ["2026-10-24 05:09:10.123456-03", "2026-10-24T08:09:10.123Z"],
    ["2026-10-24 05:09:10+05:30", "2026-10-23T23:39:10.000Z"],
    ["2026-10-24T05:09:10.250Z", "2026-10-24T05:09:10.250Z"],
  ])("%s → %s", (input, expected) => {
    expect(parseTimestamptz(input).toISOString()).toBe(expected);
  });

  test("Date passa direto", () => {
    const d = new Date();
    expect(parseTimestamptz(d)).toBe(d);
  });

  test.each(["", "ontem", "2026-13-45 00:00:00+00", 5, null, undefined])("recusa %p", (value) => {
    expect(() => parseTimestamptz(value)).toThrow();
  });
});

describe("coerceRecord", () => {
  test("converte só as colunas timestamptz, preservando null e demais valores", () => {
    const out = coerceRecord<Record<string, unknown>>(table, {
      id: "u",
      total: "1.50",
      createdAt: "2026-01-01 00:00:00.5+00",
      closedAt: null,
      payload: { a: 1 },
      seq: "7",
    });
    expect((out.createdAt as Date).toISOString()).toBe("2026-01-01T00:00:00.500Z");
    expect(out.closedAt).toBeNull();
    expect(out.total).toBe("1.50");
    expect(out.seq).toBe("7");
    expect(out.payload).toEqual({ a: 1 });
  });
});

describe("toEntitySchema", () => {
  test("gera um EntitySchema com o nome e a tabela do descritor", () => {
    const schema = toEntitySchema(table);
    expect(schema.meta.className).toBe("ThingRecord");
    expect(schema.meta.tableName).toBe("things");
  });
});
