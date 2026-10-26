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

describe("UnitOfWork.run: nível de isolamento", () => {
  const isolation = () =>
    db.uow
      .current()
      .execute<{ transaction_isolation: string }[]>("SHOW transaction_isolation")
      .then((rows) => rows[0]?.transaction_isolation);

  test("o padrão é READ COMMITTED", async () => {
    expect(await db.uow.run(isolation)).toBe("read committed");
  });

  test("REPEATABLE READ é aplicado à transação", async () => {
    expect(await db.uow.run(isolation, { isolation: "REPEATABLE READ" })).toBe("repeatable read");
  });

  /** Lê quantas linhas o consumidor tem no inbox antes e depois de um commit feito por OUTRA conexão. */
  async function countAroundForeignCommit(options?: { isolation: "REPEATABLE READ" }) {
    const consumer = `snap-${db.ids.next()}`;
    const count = async () =>
      (
        await db.uow
          .current()
          .execute<{ n: string }[]>(
            "SELECT count(*)::text AS n FROM inbox_messages WHERE consumer_name = ?",
            [consumer],
          )
      )[0]?.n;
    return db.uow.run(async () => {
      const first = await count();
      await db.sql(
        "INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES (?, 'm1', repeat('a', 64), now())",
        [consumer],
      ); // fora da transação em curso: outra conexão, commit imediato
      return [first, await count()];
    }, options);
  }

  test("REPEATABLE READ dá um snapshot: commits alheios não aparecem no meio da transação", async () => {
    expect(await countAroundForeignCommit({ isolation: "REPEATABLE READ" })).toEqual(["0", "0"]);
  });

  test("READ COMMITTED enxerga o commit alheio (contraprova do teste anterior)", async () => {
    expect(await countAroundForeignCommit()).toEqual(["0", "1"]);
  });
});

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

describe("UnitOfWork.run: retryOnConflict (só 40001/40P01)", () => {
  /** Duas transações travando duas wallets em ordem oposta: deadlock garantido na 1ª rodada. */
  async function crossLocks(retryOnConflict?: number) {
    const a = await openWalletInDb(db, "1.00");
    const b = await openWalletInDb(db, "1.00");
    const lock = (id: string) =>
      db.uow.current().execute("SELECT id FROM wallets WHERE id = ? FOR UPDATE", [id]);
    let attempts = 0;
    let arrived = 0;
    let open!: () => void;
    const bothHoldFirstLock = new Promise<void>((resolve) => {
      open = resolve;
    });
    const run = (first: string, second: string) =>
      db.uow.run(
        async () => {
          attempts++;
          await lock(first);
          if (++arrived >= 2) open(); // só a 1ª rodada espera; depois a promessa já está resolvida
          await bothHoldFirstLock;
          await lock(second);
          return "ok";
        },
        retryOnConflict === undefined ? {} : { retryOnConflict },
      );
    const results = await Promise.allSettled([run(a.id, b.id), run(b.id, a.id)]);
    return { results, attempts };
  }

  test("sem retry, o deadlock derruba uma das transações (40P01, transitório)", async () => {
    const { results, attempts } = await crossLocks();
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(classifyError((rejected[0] as PromiseRejectedResult).reason)).toMatchObject({
      kind: "TRANSIENT",
      sqlState: "40P01",
    });
    expect(attempts).toBe(2);
  });

  test("com retry, a transação derrubada é refeita e as duas terminam", async () => {
    const { results, attempts } = await crossLocks(2);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  const failWith = (code: string) => Object.assign(new Error("simulated"), { code });

  test("repete 40001 e 40P01 até esgotar as repetições e então propaga o erro", async () => {
    for (const code of ["40001", "40P01"]) {
      let attempts = 0;
      await expect(
        db.uow.run(
          async () => {
            attempts++;
            throw failWith(code);
          },
          { retryOnConflict: 2 },
        ),
      ).rejects.toMatchObject({ code });
      expect(attempts).toBe(3); // 1ª execução + 2 repetições
    }
  });

  test("não repete lock_timeout (55P03), erros permanentes nem erros de negócio", async () => {
    for (const error of [failWith("55P03"), failWith("23514"), new Error("boom")]) {
      let attempts = 0;
      await expect(
        db.uow.run(
          async () => {
            attempts++;
            throw error;
          },
          { retryOnConflict: 5 },
        ),
      ).rejects.toBe(error);
      expect(attempts).toBe(1);
    }
  });

  test("por padrão não repete nada", async () => {
    let attempts = 0;
    await expect(
      db.uow.run(async () => {
        attempts++;
        throw failWith("40001");
      }),
    ).rejects.toBeDefined();
    expect(attempts).toBe(1);
  });

  test("se a repetição der certo, devolve o valor e só a execução final fica gravada", async () => {
    const wallet = await openWalletInDb(db, "50.00");
    let attempts = 0;
    const result = await db.uow.run(
      async () => {
        attempts++;
        await applyInDbOnce(wallet.id, attempts);
        if (attempts === 1) throw failWith("40P01");
        return attempts;
      },
      { retryOnConflict: 1 },
    );
    expect(result).toBe(2);
    const rows = await db.sql<{ n: string }[]>(
      "SELECT count(*)::text AS n FROM inbox_messages WHERE consumer_name = ?",
      [`retry-${wallet.id}`],
    );
    expect(rows[0]?.n).toBe("1"); // a 1ª rodada foi desfeita por inteiro (rollback)
  });

  test("retryOnConflict inválido é recusado", async () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      await expect(db.uow.run(async () => 1, { retryOnConflict: bad })).rejects.toBeInstanceOf(
        InvalidArgumentError,
      );
    }
  });

  /** Grava uma linha de inbox dentro da transação corrente (a mesma chave a cada tentativa). */
  async function applyInDbOnce(walletId: string, attempt: number) {
    await db.uow
      .current()
      .execute(
        "INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES (?, ?, repeat('a', 64), now()) ON CONFLICT DO NOTHING",
        [`retry-${walletId}`, `m-${attempt}`],
      );
  }
});
