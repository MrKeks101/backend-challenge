import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OutboxMessage } from "../../../src/messaging/domain";
import {
  WagerTransactionKind as Kind,
  WagerTransactionProcessed,
} from "../../../src/wagering/domain";
import { createTestDatabase, expectInvariants, type TestDatabase } from "../../support/database";
import { brl } from "../../support/money";
import { newTx, openWalletInDb } from "../../support/persisted-flow";
import { at, eventContext } from "../../support/wagering";

/**
 * `claimDue` (transações pendentes e outbox) é a base dos workers. Estes testes usam um banco
 * ISOLADO por teste, para que linhas "vencidas" deixadas por outros testes não interfiram, e
 * provam o comportamento de LOCK, não só o resultado final.
 */
let db: TestDatabase;
beforeEach(async () => {
  db = await createTestDatabase();
});
afterEach(async () => {
  await expectInvariants(db);
  await db.close();
});

/** Mantém uma transação aberta (segurando o que reivindicou) até `release()`. */
function holdOpen<T>(work: () => Promise<T>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  let result!: T;
  const done = db.uow.run(async () => {
    result = await work();
    started();
    await gate;
  });
  return { ready, release, done, value: () => result };
}

async function pendingTx(
  wallet: Awaited<ReturnType<typeof openWalletInDb>>,
  ref: string,
  due: number,
) {
  const tx = newTx(db, wallet, { kind: Kind.Refund, referenceExternalTransactionId: ref });
  await db.uow.run(async () => {
    await db.transactions.claim(tx);
    tx.markPendingReference(at(due));
    await db.transactions.update(tx, at(1));
  });
  return tx;
}

async function outboxMessage(due: number) {
  const wallet = await openWalletInDb(db, "0.00");
  const tx = newTx(db, wallet);
  tx.markProcessed(undefined, at(1), brl("1.00"));
  const event = WagerTransactionProcessed.from(
    tx,
    eventContext({ eventId: db.ids.next(), occurredAt: at(due) }),
  );
  const message = OutboxMessage.enqueue(event, wallet.id);
  await db.outbox.add(message);
  return message;
}

describe("transações PENDING_REFERENCE", () => {
  test("SKIP LOCKED: o 2º worker não espera nem recebe as linhas que o 1º segura", async () => {
    const wallet = await openWalletInDb(db, "10.00");
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await pendingTx(wallet, `skip-${i}`, 100 + i)).id);

    const a = holdOpen(async () =>
      (await db.transactions.claimDue(at(1000), 2, 60_000)).map((t) => t.id),
    );
    await a.ready;
    // lockTimeout curto: se o claim esperasse pelas linhas do worker A, falharia aqui
    const b = await db.uow.run(
      async () => (await db.transactions.claimDue(at(1000), 2, 60_000)).map((t) => t.id),
      { lockTimeoutMs: 300 },
    );
    a.release();
    await a.done;

    expect(a.value()).toEqual(ids.slice(0, 2));
    expect(b).toEqual(ids.slice(2, 4));
  });

  test("vencimento é inclusivo, o LIMIT respeita a ordem de vencimento e o lease tem a duração pedida", async () => {
    const wallet = await openWalletInDb(db, "10.00");
    const late = await pendingTx(wallet, "r-late", 300);
    const early = await pendingTx(wallet, "r-early", 100);
    const middle = await pendingTx(wallet, "r-mid", 200);

    expect(await db.uow.run(() => db.transactions.claimDue(at(99), 10, 1_000))).toEqual([]);
    const exactly = await db.uow.run(() => db.transactions.claimDue(at(100), 10, 1_000_000));
    expect(exactly.map((t) => t.id)).toEqual([early.id]); // exatamente no instante: vence
    expect((await db.transactions.findById(early.id))?.nextAttemptAt?.toISOString()).toBe(
      at(1_100).toISOString(),
    );

    const first = await db.uow.run(() => db.transactions.claimDue(at(1_000), 1, 1_000));
    expect(first.map((t) => t.id)).toEqual([middle.id]); // limit 1 pega o mais antigo disponível
    const second = await db.uow.run(() => db.transactions.claimDue(at(1_000), 1, 1_000));
    expect(second.map((t) => t.id)).toEqual([late.id]);
  });

  test("uma reivindicação desfeita (rollback) não consome o lease", async () => {
    const wallet = await openWalletInDb(db, "10.00");
    const tx = await pendingTx(wallet, "r-rb", 100);
    await db.uow
      .run(async () => {
        expect(await db.transactions.claimDue(at(500), 10, 60_000)).toHaveLength(1);
        throw new Error("worker caiu");
      })
      .catch(() => undefined);
    const again = await db.uow.run(() => db.transactions.claimDue(at(500), 10, 60_000));
    expect(again.map((t) => t.id)).toEqual([tx.id]);
  });
});

describe("outbox", () => {
  test("SKIP LOCKED: o 2º publisher não espera nem recebe as mensagens que o 1º segura", async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await outboxMessage(100 + i)).id);

    const a = holdOpen(async () =>
      (await db.outbox.claimDue(at(1000), 2, 60_000)).map((m) => m.id),
    );
    await a.ready;
    const b = await db.uow.run(
      async () => (await db.outbox.claimDue(at(1000), 2, 60_000)).map((m) => m.id),
      { lockTimeoutMs: 300 },
    );
    a.release();
    await a.done;

    expect(a.value()).toEqual(ids.slice(0, 2));
    expect(b).toEqual(ids.slice(2, 4));
  });

  test("vencimento é inclusivo, o LIMIT respeita occurredAt e o lease tem a duração pedida", async () => {
    const late = await outboxMessage(300);
    const early = await outboxMessage(100);
    const middle = await outboxMessage(200);

    expect(await db.uow.run(() => db.outbox.claimDue(at(99), 10, 1_000))).toEqual([]);
    const exactly = await db.uow.run(() => db.outbox.claimDue(at(100), 10, 1_000_000));
    expect(exactly.map((m) => m.id)).toEqual([early.id]);
    expect((await db.outbox.findById(early.id))?.nextAttemptAt.toISOString()).toBe(
      at(1_100).toISOString(),
    );

    const first = await db.uow.run(() => db.outbox.claimDue(at(1_000), 1, 1_000));
    expect(first.map((m) => m.id)).toEqual([middle.id]);
    const second = await db.uow.run(() => db.outbox.claimDue(at(1_000), 1, 1_000));
    expect(second.map((m) => m.id)).toEqual([late.id]);
  });

  test("devolve em ordem de occurredAt mesmo com ids em ordem inversa", async () => {
    const newer = await outboxMessage(900);
    const older = await outboxMessage(100);
    const claimed = await db.uow.run(() => db.outbox.claimDue(at(2_000), 10, 1_000));
    expect(claimed.map((m) => m.id)).toEqual([older.id, newer.id]);
  });
});
