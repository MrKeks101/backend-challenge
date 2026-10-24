import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EntitySchema, LockMode } from "@mikro-orm/core";
import { Migration, Migrator } from "@mikro-orm/migrations";
import { MikroORM } from "@mikro-orm/postgresql";
import { TEST_DATABASE_URL } from "../support/infra";

// Spike M1: MikroORM 7 + pg sob Bun — conexão, transação, FOR UPDATE, numeric como string e Migrator up/down.

const TABLE = `spike_wallet_${Date.now()}`;

class SpikeMigration extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table ${TABLE} (id uuid primary key, balance numeric(19,2) not null check (balance >= 0))`,
    );
  }
  override async down(): Promise<void> {
    this.addSql(`drop table ${TABLE}`);
  }
}

const SpikeWallet = new EntitySchema<{ id: string; balance: string }>({
  name: "SpikeWallet",
  tableName: TABLE,
  properties: {
    id: { type: "uuid", primary: true },
    balance: { type: "string", columnType: "numeric(19,2)" },
  },
});

let orm: MikroORM;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  orm = await MikroORM.init({
    clientUrl: TEST_DATABASE_URL,
    entities: [SpikeWallet],
    extensions: [Migrator],
    migrations: {
      migrationsList: [{ name: "Migration20260101000000_spike", class: SpikeMigration }],
      tableName: `spike_migrations_${Date.now()}`,
      transactional: true,
      snapshot: false,
    },
    pool: { min: 2, max: 10 },
    discovery: { warnWhenNoEntities: false },
  });
});

afterAll(async () => {
  await orm?.close(true);
});

describe("MikroORM 7 + PostgreSQL sob Bun", () => {
  test("Migrator: up cria a tabela e down remove (migration reversível)", async () => {
    const migrator = orm.migrator;
    await migrator.up();
    const afterUp = await orm.em.execute(`select to_regclass('${TABLE}') as t`);
    expect(afterUp[0]?.t).toBe(TABLE);

    await migrator.down();
    const afterDown = await orm.em.execute(`select to_regclass('${TABLE}') as t`);
    expect(afterDown[0]?.t).toBeNull();

    await migrator.up();
  });

  test("numeric volta como string (nunca number) e CHECK impede saldo negativo", async () => {
    const em = orm.em.fork();
    await em.execute(`insert into ${TABLE} (id, balance) values (gen_random_uuid(), 100.00)`);
    const rows = await em.execute<{ balance: unknown }[]>(`select balance from ${TABLE}`);
    expect(typeof rows[0]?.balance).toBe("string");
    expect(rows[0]?.balance).toBe("100.00");

    await expect(
      em.execute(`insert into ${TABLE} (id, balance) values (gen_random_uuid(), -1.00)`),
    ).rejects.toThrow();
  });

  test("transactional faz rollback em erro", async () => {
    const id = crypto.randomUUID();
    await expect(
      orm.em.fork().transactional(async (tx) => {
        await tx.execute(`insert into ${TABLE} (id, balance) values (?, 5.00)`, [id]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await orm.em.execute(`select 1 from ${TABLE} where id = ?`, [id]);
    expect(rows).toHaveLength(0);
  });

  test("SELECT … FOR UPDATE serializa transações concorrentes e a 2ª enxerga o commit da 1ª", async () => {
    const id = crypto.randomUUID();
    await orm.em.execute(`insert into ${TABLE} (id, balance) values (?, 100.00)`, [id]);

    const order: string[] = [];
    let aHoldsLock!: () => void;
    const aLocked = new Promise<void>((r) => {
      aHoldsLock = r;
    });

    const txA = orm.em.fork().transactional(async (tx) => {
      const c = tx;
      await c.execute(`select balance from ${TABLE} where id = ? for update`, [id]);
      order.push("A:locked");
      aHoldsLock();
      await sleep(400);
      await c.execute(`update ${TABLE} set balance = balance - 80.00 where id = ?`, [id]);
      order.push("A:updated");
    });

    const txB = (async () => {
      await aLocked;
      return orm.em.fork().transactional(async (tx) => {
        const c = tx;
        const started = Date.now();
        const rows = await c.execute<{ balance: string }[]>(
          `select balance from ${TABLE} where id = ? for update`,
          [id],
        );
        order.push("B:locked");
        return { balance: rows[0]?.balance, waitedMs: Date.now() - started };
      });
    })();

    const [, b] = await Promise.all([txA, txB]);
    expect(order).toEqual(["A:locked", "A:updated", "B:locked"]);
    expect(b.balance).toBe("20.00"); // READ COMMITTED + FOR UPDATE reavalia a linha após o commit de A
    expect(b.waitedMs).toBeGreaterThanOrEqual(300);
  });

  test("LockMode.PESSIMISTIC_WRITE existe e FOR UPDATE SKIP LOCKED pula linha travada", async () => {
    expect(LockMode.PESSIMISTIC_WRITE).toBeDefined();
    const id = crypto.randomUUID();
    await orm.em.execute(`insert into ${TABLE} (id, balance) values (?, 1.00)`, [id]);

    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let aHasLock!: () => void;
    const aReady = new Promise<void>((r) => {
      aHasLock = r;
    });

    const txA = orm.em.fork().transactional(async (tx) => {
      await tx.execute(`select 1 from ${TABLE} where id = ? for update`, [id]);
      aHasLock();
      await released;
    });
    await aReady;

    const skipped = await orm.em
      .fork()
      .transactional(async (tx) =>
        tx.execute(`select id from ${TABLE} where id = ? for update skip locked`, [id]),
      );
    expect(skipped).toHaveLength(0);

    release();
    await txA;
  });
});
