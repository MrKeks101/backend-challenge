import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { classifyError } from "../../../src/shared/infrastructure/persistence/error-classifier";
import { createTestDatabase, type TestDatabase } from "../../support/database";
import { openWalletInDb } from "../../support/persisted-flow";

/**
 * Prova que o BANCO — e não só a aplicação — guarda cada invariante (AR-05, AR-09, RNF-DB-*).
 * Este arquivo insere linhas SINTÉTICAS direto em SQL (p.ex. PROCESSED sem lançamento) para provar
 * constraints; por isso NÃO roda o invariant checker global. O checker tem suíte própria.
 */
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

const now = "2026-01-01T00:00:00Z";
const id = () => db.ids.next();

/** Executa SQL e devolve o SQLSTATE do erro (ou null se não falhou). */
async function sqlState(query: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.sql(query, params);
    return null;
  } catch (error) {
    return classifyError(error).sqlState ?? "?";
  }
}

async function insertWallet(balance = "0.00", playerId = id(), currency = "BRL") {
  const walletId = id();
  await db.sql(
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [walletId, playerId, currency, balance, now, now],
  );
  return { walletId, playerId };
}

async function insertTx(
  walletId: string,
  playerId: string,
  o: Record<string, unknown> = {},
): Promise<string> {
  const txId = (o.id as string) ?? id();
  const row = {
    provider_id: "p",
    external_transaction_id: `ext-${id()}`,
    idempotency_key: `key-${id()}`,
    payload_hash: "a".repeat(64),
    kind: "BET",
    amount: "10.00",
    currency: "BRL",
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: "PENDING",
    failure_code: null,
    next_attempt_at: null,
    processed_at: null,
    ...o,
  };
  await db.sql(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
       reference_transaction_id, status, failure_code, attempts, next_attempt_at, created_at, processed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'r', 'g', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      txId,
      row.provider_id,
      row.external_transaction_id,
      row.idempotency_key,
      row.payload_hash,
      walletId,
      playerId,
      row.kind,
      row.amount,
      row.currency,
      row.reference_external_transaction_id,
      row.reference_transaction_id,
      row.status,
      row.failure_code,
      row.next_attempt_at,
      now,
      row.processed_at,
      now,
    ],
  );
  return txId;
}

const PG = {
  unique: "23505",
  check: "23514",
  fk: "23503",
  notNull: "23502",
  integrity: "23000",
} as const;

describe("wallets", () => {
  test("saldo negativo é recusado (CHECK)", async () => {
    expect(
      await sqlState(`INSERT INTO wallets VALUES (?, ?, 'BRL', -0.01, 1, ?, ?)`, [
        id(),
        id(),
        now,
        now,
      ]),
    ).toBe(PG.check);
  });

  test("version < 1 e moeda inválida são recusadas", async () => {
    expect(
      await sqlState(`INSERT INTO wallets VALUES (?, ?, 'BRL', 0, 0, ?, ?)`, [
        id(),
        id(),
        now,
        now,
      ]),
    ).toBe(PG.check);
    expect(
      await sqlState(`INSERT INTO wallets VALUES (?, ?, 'brl', 0, 1, ?, ?)`, [
        id(),
        id(),
        now,
        now,
      ]),
    ).toBe(PG.check);
  });

  test("UNIQUE (player_id, currency): segunda wallet na mesma moeda falha; outra moeda passa", async () => {
    const playerId = id();
    await insertWallet("0.00", playerId, "BRL");
    expect(
      await sqlState(`INSERT INTO wallets VALUES (?, ?, 'BRL', 0, 1, ?, ?)`, [
        id(),
        playerId,
        now,
        now,
      ]),
    ).toBe(PG.unique);
    await insertWallet("0.00", playerId, "USD");
  });

  test("UPDATE que deixaria o saldo negativo falha, mesmo com ledger coerente", async () => {
    const w = await openWalletInDb(db, "10.00");
    expect(await sqlState(`UPDATE wallets SET balance = -1 WHERE id = ?`, [w.id])).toBe(PG.check);
  });
});

describe("numeric volta como string, nunca number (RNF-DB-02)", () => {
  test("valores com muitos dígitos preservam a precisão exata", async () => {
    const w = await openWalletInDb(db, "9999999999999999.99");
    const [row] = await db.sql<{ balance: unknown }[]>(`SELECT balance FROM wallets WHERE id = ?`, [
      w.id,
    ]);
    expect(typeof row?.balance).toBe("string");
    expect(row?.balance).toBe("9999999999999999.99");
  });
});

describe("saldo × ledger (constraint trigger diferido, RF-WAL-04)", () => {
  test("alterar o saldo SEM lançamento falha no COMMIT", async () => {
    const w = await openWalletInDb(db, "100.00");
    await expect(
      db.uow.run(async () => {
        await db.uow
          .current()
          .execute(`UPDATE wallets SET balance = 90.00, version = 2 WHERE id = ?`, [w.id]);
      }),
    ).rejects.toThrow(/diverges from ledger/);
    const [row] = await db.sql<{ balance: string }[]>(`SELECT balance FROM wallets WHERE id = ?`, [
      w.id,
    ]);
    expect(row?.balance).toBe("100.00");
  });

  test("lançamento SEM alterar o saldo falha no COMMIT", async () => {
    const w = await openWalletInDb(db, "100.00");
    await expect(
      db.uow.run(async () => {
        const em = db.uow.current();
        const txId = await insertTxIn(em, w.id, w.playerId);
        await em.execute(
          `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
           VALUES (?, ?, ?, 'DEBIT', 10.00, 'BRL', 100.00, 90.00, ?)`,
          [id(), w.id, txId, now],
        );
      }),
    ).rejects.toThrow(/diverges from ledger/);
  });

  test("saldo e lançamento juntos passam; a verificação é só no COMMIT (ordem dentro da tx não importa)", async () => {
    const w = await openWalletInDb(db, "100.00");
    await db.uow.run(async () => {
      const em = db.uow.current();
      const txId = await insertTxIn(em, w.id, w.playerId, {
        status: "PROCESSED",
        processed_at: now,
      });
      // ledger primeiro, saldo depois
      await em.execute(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (?, ?, ?, 'DEBIT', 10.00, 'BRL', 100.00, 90.00, ?)`,
        [id(), w.id, txId, now],
      );
      await em.execute(`UPDATE wallets SET balance = 90.00, version = 2 WHERE id = ?`, [w.id]);
    });
    const [row] = await db.sql<{ balance: string }[]>(`SELECT balance FROM wallets WHERE id = ?`, [
      w.id,
    ]);
    expect(row?.balance).toBe("90.00");
  });

  test("wallet nova com saldo e SEM ledger de abertura falha; sem saldo passa", async () => {
    await expect(
      db.uow.run(async () => {
        await db.uow
          .current()
          .execute(`INSERT INTO wallets VALUES (?, ?, 'BRL', 5.00, 1, ?, ?)`, [
            id(),
            id(),
            now,
            now,
          ]);
      }),
    ).rejects.toThrow(/diverges from ledger/);
    await insertWallet("0.00");
  });

  test("o erro do trigger é uma violação de integridade permanente (SQLSTATE 23000)", async () => {
    const w = await openWalletInDb(db, "100.00");
    const error = await db.uow
      .run(() => db.uow.current().execute(`UPDATE wallets SET balance = 1.00 WHERE id = ?`, [w.id]))
      .catch((e: unknown) => e);
    expect(classifyError(error)).toMatchObject({ kind: "PERMANENT", sqlState: PG.integrity });
  });
});

// helper que insere uma transação usando o em da transação em curso
async function insertTxIn(
  em: ReturnType<TestDatabase["uow"]["current"]>,
  walletId: string,
  playerId: string,
  o: { status?: string; processed_at?: string } = {},
): Promise<string> {
  const txId = id();
  await em.execute(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency, status, attempts, created_at, processed_at, updated_at)
     VALUES (?, 'p', ?, ?, ?, ?, ?, 'r', 'g', 'BET', 10.00, 'BRL', ?, 0, ?, ?, ?)`,
    [
      txId,
      `e-${txId}`,
      `k-${txId}`,
      "a".repeat(64),
      walletId,
      playerId,
      o.status ?? "PENDING",
      now,
      o.processed_at ?? null,
      now,
    ],
  );
  return txId;
}

describe("ledger é append-only (AR-05)", () => {
  let w: Awaited<ReturnType<typeof openWalletInDb>>;
  beforeAll(async () => {
    w = await openWalletInDb(db, "50.00");
  });

  test("UPDATE falha", async () => {
    expect(
      await sqlState(`UPDATE wallet_ledger_entries SET amount = 1.00 WHERE wallet_id = ?`, [w.id]),
    ).toBe(PG.integrity);
  });

  test("DELETE falha", async () => {
    expect(await sqlState(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [w.id])).toBe(
      PG.integrity,
    );
  });

  test("TRUNCATE falha", async () => {
    expect(await sqlState(`TRUNCATE wallet_ledger_entries`)).toBe(PG.integrity);
  });

  test("a mensagem diz que o ledger é append-only", async () => {
    await expect(db.sql(`DELETE FROM wallet_ledger_entries`)).rejects.toThrow(/append-only/);
  });

  test("o lançamento continua intacto depois das tentativas", async () => {
    const rows = await db.sql<{ amount: string }[]>(
      `SELECT amount FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [w.id],
    );
    expect(rows.map((r) => r.amount)).toEqual(["50.00"]);
  });

  test("aritmética do lançamento é conferida pelo CHECK", async () => {
    const wal = await insertWallet();
    const txId = await insertTx(wal.walletId, wal.playerId);
    const bad = (direction: string, before: string, after: string, amount = "10.00") =>
      sqlState(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
         VALUES (?, ?, ?, ?, ?, 'BRL', ?, ?, ?)`,
        [id(), wal.walletId, txId, direction, amount, before, after, now],
      );
    expect(await bad("CREDIT", "0.00", "9.99")).toBe(PG.check);
    expect(await bad("DEBIT", "20.00", "11.00")).toBe(PG.check);
    // before = after = 0: a aritmética fecha, então só o CHECK de amount > 0 pode recusar
    expect(await bad("CREDIT", "0.00", "0.00", "0.00")).toBe(PG.check);
    expect(await bad("DEBIT", "0.00", "0.00", "0.00")).toBe(PG.check);
    expect(await bad("SIDEWAYS", "0.00", "10.00")).toBe(PG.check);
  });

  test("UNIQUE (wallet_id, transaction_id): um único lançamento por transação", async () => {
    const wal = await openWalletInDb(db, "30.00");
    const [opening] = await db.sql<{ transaction_id: string }[]>(
      `SELECT transaction_id FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [wal.id],
    );
    expect(
      await sqlState(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES (?, ?, ?, 'CREDIT', 1.00, 'BRL', 30.00, 31.00, ?)`,
        [id(), wal.id, opening?.transaction_id, now],
      ),
    ).toBe(PG.unique);
  });

  test("seq cresce monotonicamente e não aceita valor explícito", async () => {
    const rows = await db.sql<{ seq: string }[]>(
      `SELECT seq FROM wallet_ledger_entries ORDER BY seq`,
    );
    const seqs = rows.map((r) => BigInt(r.seq));
    expect(seqs.every((s, i) => i === 0 || s > (seqs[i - 1] as bigint))).toBe(true);
    expect(
      await sqlState(
        `INSERT INTO wallet_ledger_entries (seq, id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       VALUES (999999, ?, ?, ?, 'CREDIT', 1, 'BRL', 0, 1, ?)`,
        [id(), w.id, id(), now],
      ),
    ).not.toBeNull();
  });
});

describe("wager_transactions", () => {
  let wal: { walletId: string; playerId: string };
  beforeAll(async () => {
    wal = await insertWallet();
  });

  test("UNIQUE idempotency_key", async () => {
    const key = `k-${id()}`;
    await insertTx(wal.walletId, wal.playerId, { idempotency_key: key });
    expect(
      await sqlState(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, attempts, created_at, updated_at)
       VALUES (?, 'p', ?, ?, ?, ?, ?, 'r', 'g', 'BET', 1, 'BRL', 'PENDING', 0, ?, ?)`,
        [id(), `e-${id()}`, key, "a".repeat(64), wal.walletId, wal.playerId, now, now],
      ),
    ).toBe(PG.unique);
  });

  test("UNIQUE (provider_id, external_transaction_id); outro provedor pode reusar o id externo", async () => {
    const ext = `ext-${id()}`;
    await insertTx(wal.walletId, wal.playerId, { provider_id: "pa", external_transaction_id: ext });
    expect(
      await sqlState(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, attempts, created_at, updated_at)
       VALUES (?, 'pa', ?, ?, ?, ?, ?, 'r', 'g', 'BET', 1, 'BRL', 'PENDING', 0, ?, ?)`,
        [id(), ext, `k-${id()}`, "a".repeat(64), wal.walletId, wal.playerId, now, now],
      ),
    ).toBe(PG.unique);
    await insertTx(wal.walletId, wal.playerId, { provider_id: "pb", external_transaction_id: ext });
  });

  test("wallet inexistente é recusada (FK)", async () => {
    await expect(insertTx(id(), id())).rejects.toThrow();
    expect(classifyError(await insertTx(id(), id()).catch((e: unknown) => e)).sqlState).toBe(PG.fk);
  });

  test("REFUND/ROLLBACK exigem referência", async () => {
    for (const kind of ["REFUND", "ROLLBACK"]) {
      await expect(insertTx(wal.walletId, wal.playerId, { kind })).rejects.toThrow(
        /ck_wager_reference_required/,
      );
    }
    await insertTx(wal.walletId, wal.playerId, {
      kind: "REFUND",
      reference_external_transaction_id: "x",
    });
  });

  test("valor: BET/WIN/REFUND/ROLLBACK > 0; LOSS pode ser zero; nunca negativo", async () => {
    await expect(insertTx(wal.walletId, wal.playerId, { amount: "0.00" })).rejects.toThrow(
      /ck_wager_amount_positive/,
    );
    await insertTx(wal.walletId, wal.playerId, { kind: "LOSS", amount: "0.00" });
    await expect(
      insertTx(wal.walletId, wal.playerId, { kind: "LOSS", amount: "-1.00" }),
    ).rejects.toThrow();
  });

  test("kind e status desconhecidos são recusados", async () => {
    await expect(insertTx(wal.walletId, wal.playerId, { kind: "JACKPOT" })).rejects.toThrow();
    await expect(insertTx(wal.walletId, wal.playerId, { status: "DONE" })).rejects.toThrow();
  });

  test("REJECTED/FAILED exigem failure_code; PROCESSED exige processed_at; PENDING_REFERENCE exige next_attempt_at", async () => {
    await expect(insertTx(wal.walletId, wal.playerId, { status: "REJECTED" })).rejects.toThrow(
      /ck_wager_failure_code/,
    );
    await expect(insertTx(wal.walletId, wal.playerId, { status: "FAILED" })).rejects.toThrow(
      /ck_wager_failure_code/,
    );
    await expect(insertTx(wal.walletId, wal.playerId, { status: "PROCESSED" })).rejects.toThrow(
      /ck_wager_processed_at/,
    );
    await expect(
      insertTx(wal.walletId, wal.playerId, {
        status: "PENDING_REFERENCE",
        reference_external_transaction_id: "x",
        kind: "REFUND",
      }),
    ).rejects.toThrow(/ck_wager_pending_schedule/);
  });

  describe("reversão única (D7)", () => {
    test("duas reversões PROCESSED da mesma transação: a segunda falha, de qualquer tipo", async () => {
      const original = await insertTx(wal.walletId, wal.playerId, {
        status: "PROCESSED",
        processed_at: now,
      });
      const reversal = (kind: string, status = "PROCESSED") =>
        insertTx(wal.walletId, wal.playerId, {
          kind,
          status,
          reference_external_transaction_id: "orig",
          reference_transaction_id: original,
          processed_at: status === "PROCESSED" ? now : null,
          failure_code: status === "REJECTED" ? "ALREADY_REVERSED" : null,
        });
      await reversal("REFUND");
      await expect(reversal("REFUND")).rejects.toThrow(/uq_wager_single_reversal/);
      await expect(reversal("ROLLBACK")).rejects.toThrow(/uq_wager_single_reversal/);
    });

    test("reversões REJECTED ou PENDING não ocupam a vaga (índice parcial)", async () => {
      const original = await insertTx(wal.walletId, wal.playerId, {
        status: "PROCESSED",
        processed_at: now,
      });
      const reversal = (status: string, extra: Record<string, unknown> = {}) =>
        insertTx(wal.walletId, wal.playerId, {
          kind: "REFUND",
          status,
          reference_external_transaction_id: "orig",
          reference_transaction_id: original,
          ...extra,
        });
      await reversal("REJECTED", { failure_code: "ALREADY_REVERSED" });
      await reversal("REJECTED", { failure_code: "ALREADY_REVERSED" });
      await reversal("PENDING");
      await reversal("PROCESSED", { processed_at: now }); // a vaga continua livre
    });
  });
});

describe("inbox e outbox", () => {
  test("inbox: PK (consumer_name, message_id) impede duplicata; outro consumidor pode repetir o id", async () => {
    const insert = (consumer: string, message: string) =>
      sqlState(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at) VALUES (?, ?, ?, ?)`,
        [consumer, message, "b".repeat(64), now],
      );
    expect(await insert("c1", "m1")).toBeNull();
    expect(await insert("c1", "m1")).toBe(PG.unique);
    expect(await insert("c2", "m1")).toBeNull();
  });

  test("outbox: id é único e payload é jsonb", async () => {
    const eventId = id();
    const insert = () =>
      sqlState(
        `INSERT INTO outbox_messages (id, aggregate_id, message_group_id, event_type, payload, occurred_at, next_attempt_at)
         VALUES (?, 'a', 'g', 'T', '{"a":1}'::jsonb, ?, ?)`,
        [eventId, now, now],
      );
    expect(await insert()).toBeNull();
    expect(await insert()).toBe(PG.unique);
    const [row] = await db.sql<{ payload: unknown }[]>(
      `SELECT payload FROM outbox_messages WHERE id = ?`,
      [eventId],
    );
    expect(row?.payload).toEqual({ a: 1 });
  });
});
