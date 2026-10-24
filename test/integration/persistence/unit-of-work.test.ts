import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { classifyError } from "../../../src/shared/infrastructure/persistence/error-classifier";
import { NoTransactionError } from "../../../src/shared/infrastructure/persistence/errors";
import { InvalidArgumentError } from "../../../src/shared/kernel";
import { createTestDatabase, expectInvariants, type TestDatabase } from "../../support/database";
import { brl } from "../../support/money";
import { applyInDb, newTx, openWalletInDb } from "../../support/persisted-flow";

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await expectInvariants(db);
  await db.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("UnitOfWork.run", () => {
  test("devolve o valor de fn e faz COMMIT", async () => {
    const wallet = await openWalletInDb(db, "10.00");
    const result = await db.uow.run(async () => {
      await db.uow.current().execute(`UPDATE outbox_messages SET attempts = attempts WHERE false`);
      return (await db.wallets.findById(wallet.id))?.id;
    });
    expect(result).toBe(wallet.id);
  });

  test("erro em fn faz ROLLBACK de tudo e é propagado intacto", async () => {
    const wallet = await openWalletInDb(db, "100.00");
    const tx = newTx(db, wallet);
    const boom = new Error("boom");
    await expect(
      db.uow.run(async () => {
        await db.transactions.claim(tx);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(await db.transactions.findById(tx.id)).toBeNull();
  });

  test("leituras dentro da transação enxergam as próprias escritas; de fora, só após o COMMIT", async () => {
    const wallet = await openWalletInDb(db, "100.00");
    const tx = newTx(db, wallet);
    let outsideBeforeCommit: unknown = "not-run";
    await db.uow.run(async () => {
      await db.transactions.claim(tx);
      expect(await db.transactions.findById(tx.id)).not.toBeNull();
      // uma conexão fora da transação não vê (READ COMMITTED)
      outsideBeforeCommit = (await db.sql(`SELECT 1 FROM wager_transactions WHERE id = ?`, [tx.id]))
        .length;
    });
    expect(outsideBeforeCommit).toBe(0);
    expect(await db.transactions.findById(tx.id)).not.toBeNull();
  });

  test("chamada aninhada ENTRA na transação em curso (um único COMMIT/ROLLBACK)", async () => {
    const wallet = await openWalletInDb(db, "100.00");
    const a = newTx(db, wallet);
    const b = newTx(db, wallet);
    await expect(
      db.uow.run(async () => {
        await db.transactions.claim(a);
        await db.uow.run(async () => {
          await db.transactions.claim(b);
        });
        throw new Error("abort externo");
      }),
    ).rejects.toThrow("abort externo");
    expect(await db.transactions.findById(a.id)).toBeNull();
    expect(await db.transactions.findById(b.id)).toBeNull(); // o aninhado também foi desfeito
  });

  test("inTransaction reflete o contexto, inclusive dentro de chamadas assíncronas aninhadas", async () => {
    expect(db.uow.inTransaction()).toBe(false);
    await db.uow.run(async () => {
      expect(db.uow.inTransaction()).toBe(true);
      await sleep(5);
      await Promise.all([sleep(1), (async () => expect(db.uow.inTransaction()).toBe(true))()]);
    });
    expect(db.uow.inTransaction()).toBe(false);
  });

  test("transações concorrentes não vazam contexto entre si", async () => {
    const wallet = await openWalletInDb(db, "1000.00");
    const txs = Array.from({ length: 8 }, () => newTx(db, wallet, { money: brl("1.00") }));
    await Promise.all(
      txs.map((tx, i) =>
        db.uow
          .run(async () => {
            await sleep((i % 3) * 5);
            await db.transactions.claim(tx);
            await sleep(5);
            if (i % 2 === 1) throw new Error("abort");
          })
          .catch(() => undefined),
      ),
    );
    const present = await Promise.all(txs.map((tx) => db.transactions.findById(tx.id)));
    expect(present.map((p) => p !== null)).toEqual(txs.map((_, i) => i % 2 === 0));
  });

  test("current() fora de transação usa autocommit (cada comando é durável)", async () => {
    const wallet = await openWalletInDb(db, "5.00");
    const tx = newTx(db, wallet);
    await db.transactions.claim(tx); // sem uow.run
    expect(await db.transactions.findById(tx.id)).not.toBeNull();
  });

  test("requireTransaction fora de transação lança NoTransactionError", () => {
    expect(() => db.uow.requireTransaction("x")).toThrow(NoTransactionError);
  });
});

describe("timeouts por transação", () => {
  test("lock_timeout: quem espera uma linha travada falha rápido e o erro é TRANSITÓRIO", async () => {
    const wallet = await openWalletInDb(db, "50.00");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let holding!: () => void;
    const holdingStarted = new Promise<void>((r) => {
      holding = r;
    });

    const holder = db.uow.run(async () => {
      await db.wallets.findByIdForUpdate(wallet.id);
      holding();
      await gate;
    });
    await holdingStarted;

    const started = Date.now();
    const error = await db.uow
      .run(() => db.wallets.findByIdForUpdate(wallet.id), { lockTimeoutMs: 200 })
      .catch((e: unknown) => e);
    const waited = Date.now() - started;
    release();
    await holder;

    expect(error).toBeInstanceOf(Error);
    expect(classifyError(error)).toMatchObject({
      kind: "TRANSIENT",
      sqlState: "55P03",
      reason: "lock_not_available",
    });
    expect(waited).toBeGreaterThanOrEqual(150);
    expect(waited).toBeLessThan(3_000);
  });

  test("statement_timeout cancela comando lento (57014, transitório)", async () => {
    const error = await db.uow
      .run(() => db.uow.current().execute(`SELECT pg_sleep(2)`), { statementTimeoutMs: 100 })
      .catch((e: unknown) => e);
    expect(classifyError(error)).toMatchObject({ kind: "TRANSIENT", sqlState: "57014" });
  });

  test("os timeouts valem só para a transação (SET LOCAL): a próxima usa o padrão", async () => {
    await db.uow.run(() => db.uow.current().execute(`SELECT 1`), { lockTimeoutMs: 123 });
    const [row] = await db.uow.run(() =>
      db.uow.current().execute<{ lock_timeout: string }[]>(`SHOW lock_timeout`),
    );
    expect(row?.lock_timeout).toBe("5s");
  });

  test("a transação aplica lock_timeout e statement_timeout configurados", async () => {
    const [lock] = await db.uow.run(
      () => db.uow.current().execute<{ lock_timeout: string }[]>(`SHOW lock_timeout`),
      { lockTimeoutMs: 1500, statementTimeoutMs: 7000 },
    );
    const [stmt] = await db.uow.run(
      () => db.uow.current().execute<{ statement_timeout: string }[]>(`SHOW statement_timeout`),
      { lockTimeoutMs: 1500, statementTimeoutMs: 7000 },
    );
    expect(lock?.lock_timeout).toBe("1500ms");
    expect(stmt?.statement_timeout).toBe("7s");
  });

  test.each([0, -5, 1.5, Number.NaN])("recusa timeout inválido %p", async (value) => {
    await expect(db.uow.run(async () => 1, { lockTimeoutMs: value })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    await expect(db.uow.run(async () => 1, { statementTimeoutMs: value })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
  });
});

describe("concorrência real sobre a mesma wallet (FOR UPDATE)", () => {
  test("20 apostas paralelas na mesma wallet: sem deadlock, saldo final exato, ledger íntegro", async () => {
    const wallet = await openWalletInDb(db, "100.00");
    const txs = Array.from({ length: 20 }, () => newTx(db, wallet, { money: brl("10.00") }));
    const results = await Promise.all(txs.map((tx) => applyInDb(db, tx)));

    const processed = results.filter((r) => r.status === "PROCESSED");
    const rejected = results.filter((r) => r.status === "REJECTED");
    expect(processed).toHaveLength(10); // 100.00 / 10.00
    expect(rejected).toHaveLength(10);
    expect(rejected.every((r) => r.failureCode === "INSUFFICIENT_FUNDS")).toBe(true);
    const [row] = await db.sql<{ balance: string; version: number }[]>(
      `SELECT balance, version FROM wallets WHERE id = ?`,
      [wallet.id],
    );
    expect(row?.balance).toBe("0.00");
    expect(row?.version).toBe(11);
  });
});

describe("mistura concorrente de tipos sobre várias wallets (semente fixa)", () => {
  test("BET/WIN/LOSS/REFUND/ROLLBACK em paralelo: nenhum deadlock e invariantes íntegras", async () => {
    const { seededRandom } = await import("../../support/money");
    const { WagerTransactionKind: K } = await import("../../../src/wagering/domain");
    const random = seededRandom(20261024);
    const wallets = await Promise.all([1, 2, 3].map(() => openWalletInDb(db, "200.00")));

    // primeiro as apostas (referências), depois as demais, tudo disparado em paralelo por rodada
    const bets = wallets.flatMap((w) =>
      Array.from({ length: 6 }, () =>
        newTx(db, w, { money: brl(`${1 + Math.floor(random() * 20)}.00`) }),
      ),
    );
    await Promise.all(bets.map((tx) => applyInDb(db, tx)));

    const followUps = bets.flatMap((bet, i) => {
      const w = wallets[Math.floor(i / 6)] as (typeof wallets)[number];
      const ref = { referenceExternalTransactionId: bet.externalTransactionId };
      const kinds = [K.Win, K.Loss, K.Refund, K.Rollback] as const;
      const kind = kinds[Math.floor(random() * kinds.length)] as (typeof kinds)[number];
      const money =
        kind === K.Loss
          ? brl("0.00")
          : kind === K.Win
            ? brl(`${1 + Math.floor(random() * 30)}.00`)
            : bet.money;
      return [newTx(db, w, { kind, money, ...ref })];
    });
    const results = await Promise.all(followUps.map((tx) => applyInDb(db, tx)));
    expect(results.every((r) => ["PROCESSED", "REJECTED"].includes(r.status))).toBe(true);
    await expectInvariants(db);
  });
});
