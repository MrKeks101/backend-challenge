import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { InboxMessage, OutboxMessage } from "../../../src/messaging/domain";
import {
  NoTransactionError,
  OptimisticLockError,
} from "../../../src/shared/infrastructure/persistence/errors";
import { InvalidArgumentError, sha256Hex } from "../../../src/shared/kernel";
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  WagerTransactionProcessed,
} from "../../../src/wagering/domain";
import { LedgerDirection, Wallet } from "../../../src/wallet/domain";
import { createTestDatabase, expectInvariants, type TestDatabase } from "../../support/database";
import { brl } from "../../support/money";
import { applyInDb, newTx, openWalletInDb } from "../../support/persisted-flow";
import { at, eventContext } from "../../support/wagering";

let db: TestDatabase;

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await expectInvariants(db);
  await db.close();
});

describe("WalletRepository", () => {
  test("insert + findById devolvem o mesmo aggregate (round-trip exato de Money)", async () => {
    const original = await openWalletInDb(db, "1234567890123.45");
    const loaded = await db.wallets.findById(original.id);
    expect(loaded?.id).toBe(original.id);
    expect(loaded?.playerId).toBe(original.playerId);
    expect(loaded?.currency).toBe("BRL");
    expect(loaded?.balance.toString()).toBe("1234567890123.45 BRL");
    expect(loaded?.version).toBe(1);
    expect(loaded?.createdAt.toISOString()).toBe(at(0).toISOString());
  });

  test("o valor máximo e o mínimo positivo sobrevivem ao banco sem perda", async () => {
    for (const amount of ["9999999999999999.99", "0.01"]) {
      const wallet = await openWalletInDb(db, amount);
      expect((await db.wallets.findById(wallet.id))?.balance.toJSON().amount).toBe(amount);
    }
  });

  test("insert devolve false para (player, moeda) repetido, sem alterar a existente", async () => {
    const first = await openWalletInDb(db, "10.00");
    const { wallet: duplicate } = Wallet.open({
      id: db.ids.next(),
      playerId: first.playerId,
      initialBalance: brl("0.00"),
      createdAt: at(9),
    });
    expect(await db.wallets.insert(duplicate)).toBe(false);
    expect(await db.wallets.findById(duplicate.id)).toBeNull();
    expect((await db.wallets.findById(first.id))?.balance.toString()).toBe("10.00 BRL");
  });

  test("findByPlayerAndCurrency; outra moeda não encontra", async () => {
    const wallet = await openWalletInDb(db, "5.00");
    expect((await db.wallets.findByPlayerAndCurrency(wallet.playerId, "BRL"))?.id).toBe(wallet.id);
    expect(await db.wallets.findByPlayerAndCurrency(wallet.playerId, "USD")).toBeNull();
  });

  test("findById de id inexistente devolve null", async () => {
    expect(await db.wallets.findById(db.ids.next())).toBeNull();
  });

  test("findByIdForUpdate exige transação", async () => {
    const wallet = await openWalletInDb(db, "5.00");
    await expect(db.wallets.findByIdForUpdate(wallet.id)).rejects.toBeInstanceOf(
      NoTransactionError,
    );
    const locked = await db.uow.run(() => db.wallets.findByIdForUpdate(wallet.id));
    expect(locked?.id).toBe(wallet.id);
  });

  test("save com versão correta persiste saldo, versão e horário", async () => {
    const wallet = await openWalletInDb(db, "100.00");
    const after = await applyBet(wallet, "30.00");
    expect(after.balance.toString()).toBe("70.00 BRL");
    const loaded = await db.wallets.findById(wallet.id);
    expect(loaded?.balance.toString()).toBe("70.00 BRL");
    expect(loaded?.version).toBe(2);
    expect(loaded?.updatedAt.toISOString()).toBe(at(5).toISOString());
  });

  test("save com versão defasada lança OptimisticLockError e não altera nada", async () => {
    const wallet = await openWalletInDb(db, "100.00");
    const stale = (await db.wallets.findById(wallet.id)) as Wallet;
    await applyBet(wallet, "10.00"); // avança a versão no banco
    await expect(db.wallets.save(stale, 1)).rejects.toBeInstanceOf(OptimisticLockError);
    expect((await db.wallets.findById(wallet.id))?.version).toBe(2);
  });

  async function applyBet(wallet: Wallet, amount: string) {
    return applyInDb(db, newTx(db, wallet, { money: brl(amount) }));
  }
});

describe("LedgerRepository", () => {
  test("append + findByTransaction + findLast", async () => {
    const wallet = await openWalletInDb(db, "100.00");
    const tx = newTx(db, wallet, { money: brl("40.00") });
    await applyInDb(db, tx);

    const entry = await db.ledger.findByTransaction(wallet.id, tx.id);
    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(entry?.money.toString()).toBe("40.00 BRL");
    expect(entry?.balanceBefore.toString()).toBe("100.00 BRL");
    expect(entry?.balanceAfter.toString()).toBe("60.00 BRL");
    expect(entry?.isBalanced()).toBe(true);
    expect((await db.ledger.findLast(wallet.id))?.id).toBe(entry?.id as string);
  });

  test("findByTransaction/findLast sem registros devolvem null", async () => {
    const wallet = await openWalletInDb(db, "0.00");
    expect(await db.ledger.findLast(wallet.id)).toBeNull();
    expect(await db.ledger.findByTransaction(wallet.id, db.ids.next())).toBeNull();
  });

  describe("summarize (base da reconciliação)", () => {
    test("soma créditos − débitos e conta os lançamentos", async () => {
      const wallet = await openWalletInDb(db, "100.00");
      const bet = newTx(db, wallet, { money: brl("30.00") });
      await applyInDb(db, bet);
      await applyInDb(
        db,
        newTx(db, wallet, {
          kind: Kind.Win,
          money: brl("12.50"),
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );
      const summary = await db.ledger.summarize(wallet.id, "BRL");
      expect(summary.entries).toBe(3);
      expect(summary.net.toString()).toBe("82.50 BRL");
    });

    test("sem lançamentos: zero lançamentos e soma 0.00", async () => {
      const wallet = await openWalletInDb(db, "0.00");
      const summary = await db.ledger.summarize(wallet.id, "BRL");
      expect(summary.entries).toBe(0);
      expect(summary.net.toString()).toBe("0.00 BRL");
    });

    test("só soma a wallet pedida", async () => {
      const a = await openWalletInDb(db, "10.00");
      await openWalletInDb(db, "999.00");
      expect((await db.ledger.summarize(a.id, "BRL")).net.toString()).toBe("10.00 BRL");
    });
  });

  describe("paginação por cursor", () => {
    let wallet: Wallet;
    beforeAll(async () => {
      wallet = await openWalletInDb(db, "1000.00");
      for (let i = 1; i <= 7; i++) {
        await applyInDb(db, newTx(db, wallet, { money: brl(`${i}.00`) }), at(10 + i));
      }
    });

    test("do mais novo para o mais antigo, sem repetir nem pular entre páginas", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await db.ledger.page(wallet.id, {
          limit: 3,
          ...(cursor ? { beforeSeq: cursor } : {}),
        });
        seen.push(...page.items.map((i) => i.entry.id));
        cursor = page.nextBeforeSeq ?? undefined;
        pages++;
      } while (cursor);
      expect(pages).toBe(3); // 8 lançamentos (abertura + 7) em páginas de 3
      expect(seen).toHaveLength(8);
      expect(new Set(seen).size).toBe(8);
      const all = await db.ledger.page(wallet.id, { limit: 200 });
      expect(seen).toEqual(all.items.map((i) => i.entry.id));
      const seqs = all.items.map((i) => BigInt(i.seq));
      expect(seqs.every((s, i) => i === 0 || s < (seqs[i - 1] as bigint))).toBe(true);
      expect(all.items.at(-1)?.entry.balanceBefore.isZero()).toBe(true); // o mais antigo é a abertura
      expect(all.nextBeforeSeq).toBeNull();
    });

    test("página exata não anuncia próxima página", async () => {
      expect((await db.ledger.page(wallet.id, { limit: 8 })).nextBeforeSeq).toBeNull();
      expect((await db.ledger.page(wallet.id, { limit: 7 })).nextBeforeSeq).not.toBeNull();
    });

    test("só devolve lançamentos da wallet pedida", async () => {
      const other = await openWalletInDb(db, "1.00");
      const page = await db.ledger.page(other.id, { limit: 50 });
      expect(page.items).toHaveLength(1);
    });

    test("limit e cursor inválidos são recusados", async () => {
      for (const limit of [0, 201, 1.5, -1]) {
        await expect(db.ledger.page(wallet.id, { limit })).rejects.toBeInstanceOf(
          InvalidArgumentError,
        );
      }
      await expect(
        db.ledger.page(wallet.id, { limit: 5, beforeSeq: "1; DROP TABLE wallets" }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
    });
  });
});

describe("WagerTransactionRepository", () => {
  let wallet: Wallet;
  beforeAll(async () => {
    wallet = await openWalletInDb(db, "500.00");
  });

  test("claim cria a transação e a recarrega idêntica", async () => {
    const tx = newTx(db, wallet, { money: brl("12.34"), roundId: "round-xyz", gameId: "g" });
    expect(await db.transactions.claim(tx)).toBe(true);
    const loaded = await db.transactions.findById(tx.id);
    expect(loaded?.status).toBe(Status.Pending);
    expect(loaded?.payloadHash).toBe(tx.payloadHash);
    expect(loaded?.money.toString()).toBe("12.34 BRL");
    expect(loaded?.roundId).toBe("round-xyz");
    expect(loaded?.kind).toBe(Kind.Bet);
    expect(loaded?.referenceExternalTransactionId).toBeUndefined();
    expect(loaded?.attempts).toBe(0);
    expect(loaded?.matchesPayload(tx.payloadHash)).toBe(true);
  });

  test("claim repetido (mesma key) devolve false e preserva o original", async () => {
    const tx = newTx(db, wallet);
    expect(await db.transactions.claim(tx)).toBe(true);
    const again = newTx(db, wallet, {
      externalTransactionId: tx.externalTransactionId,
      money: brl("99.00"),
    });
    expect(await db.transactions.claim(again)).toBe(false);
    expect((await db.transactions.findByIdempotencyKey(tx.idempotencyKey))?.id).toBe(tx.id);
    expect((await db.transactions.findById(tx.id))?.money.toString()).toBe("10.00 BRL");
  });

  test("claim com key nova mas (provedor, externalId) já usado devolve false", async () => {
    const tx = newTx(db, wallet);
    await db.transactions.claim(tx);
    const sameExternal = newTx(db, wallet, {
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: `outra-key-${db.ids.next()}`,
    });
    expect(await db.transactions.claim(sameExternal)).toBe(false);
    expect(
      (await db.transactions.findByExternalId("provider-a", tx.externalTransactionId))?.id,
    ).toBe(tx.id);
    expect(await db.transactions.findByIdempotencyKey(sameExternal.idempotencyKey)).toBeNull();
  });

  test("findBy* inexistentes devolvem null", async () => {
    expect(await db.transactions.findById(db.ids.next())).toBeNull();
    expect(await db.transactions.findByIdempotencyKey("nope")).toBeNull();
    expect(await db.transactions.findByExternalId("provider-a", "nope")).toBeNull();
  });

  test("claim dentro de transação desfeita (rollback) não deixa rastro", async () => {
    const tx = newTx(db, wallet);
    await db.uow
      .run(async () => {
        expect(await db.transactions.claim(tx)).toBe(true);
        throw new Error("abort");
      })
      .catch(() => undefined);
    expect(await db.transactions.findById(tx.id)).toBeNull();
  });

  describe("update", () => {
    test("persiste PROCESSED com referência, saldo observado e instante", async () => {
      const bet = newTx(db, wallet);
      await applyInDb(db, bet);
      const refund = newTx(db, wallet, {
        kind: Kind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
        money: bet.money,
      });
      await applyInDb(db, refund, at(8));
      const loaded = await db.transactions.findById(refund.id);
      expect(loaded?.status).toBe(Status.Processed);
      expect(loaded?.referenceTransactionId).toBe(bet.id);
      expect(loaded?.processedAt?.toISOString()).toBe(at(8).toISOString());
      expect(loaded?.observedBalance?.currency).toBe("BRL");
    });

    test("persiste REJECTED com failureCode e saldo observado", async () => {
      const poor = await openWalletInDb(db, "5.00");
      const tx = newTx(db, poor, { money: brl("50.00") });
      const result = await applyInDb(db, tx);
      expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
      const loaded = await db.transactions.findById(tx.id);
      expect(loaded?.status).toBe(Status.Rejected);
      expect(loaded?.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(loaded?.observedBalance?.toString()).toBe("5.00 BRL");
      expect((await db.wallets.findById(poor.id))?.balance.toString()).toBe("5.00 BRL"); // saldo intacto
    });

    test("persiste PENDING_REFERENCE com tentativas e agendamento; depois resolve", async () => {
      const refund = newTx(db, wallet, {
        kind: Kind.Refund,
        referenceExternalTransactionId: "ainda-nao-chegou",
      });
      const result = await applyInDb(db, refund);
      expect(result.status).toBe(Status.PendingReference);
      const loaded = present(await db.transactions.findById(refund.id));
      expect(loaded.status).toBe(Status.PendingReference);
      expect(loaded.nextAttemptAt?.toISOString()).toBe(at(7).toISOString());
      loaded.markPendingReference(at(20));
      await db.transactions.update(loaded, at(9));
      expect((await db.transactions.findById(refund.id))?.attempts).toBe(1);
    });

    test("o banco recusa reescrever transação terminal (OptimisticLockError)", async () => {
      const tx = newTx(db, wallet);
      await applyInDb(db, tx);
      const loaded = present(await db.transactions.findById(tx.id));
      const reloadedAsPending = newTx(db, wallet);
      await expect(db.transactions.update(reloadedAsPending, at(9))).rejects.toBeInstanceOf(
        OptimisticLockError,
      ); // inexistente
      // simula um bug: reabrir o estado em memória e tentar gravar por cima de uma linha terminal
      const forged = (await import("../../../src/wagering/domain")).WagerTransaction.rehydrate({
        ...snapshot(loaded),
        status: Status.Failed,
        failureCode: FailureCode.InternalPermanentError,
      });
      await expect(db.transactions.update(forged, at(10))).rejects.toBeInstanceOf(
        OptimisticLockError,
      );
      expect((await db.transactions.findById(tx.id))?.status).toBe(Status.Processed);
    });
  });

  describe("hasProcessedReversal", () => {
    test("false sem reversão; true após REFUND processado; rejeitado não conta", async () => {
      const bet = newTx(db, wallet);
      await applyInDb(db, bet);
      expect(await db.transactions.hasProcessedReversal(bet.id)).toBe(false);

      const wrongAmount = newTx(db, wallet, {
        kind: Kind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
        money: brl("1.00"),
      });
      expect((await applyInDb(db, wrongAmount)).failureCode).toBe(
        FailureCode.ReferenceAmountMismatch,
      );
      expect(await db.transactions.hasProcessedReversal(bet.id)).toBe(false);

      const refund = newTx(db, wallet, {
        kind: Kind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
        money: bet.money,
      });
      expect((await applyInDb(db, refund)).status).toBe(Status.Processed);
      expect(await db.transactions.hasProcessedReversal(bet.id)).toBe(true);
    });

    test("só PROCESSED conta: reversão com a referência preenchida mas REJECTED/FAILED/PENDING é ignorada", async () => {
      const other = await openWalletInDb(db, "50.00");
      const bet = newTx(db, other);
      await applyInDb(db, bet);
      for (const [status, extra] of [
        ["REJECTED", ", failure_code = 'ALREADY_REVERSED'"],
        ["FAILED", ", failure_code = 'INTERNAL_PERMANENT_ERROR'"],
        ["PENDING", ""],
      ] as const) {
        const reversal = newTx(db, other, {
          kind: Kind.Refund,
          referenceExternalTransactionId: bet.externalTransactionId,
          money: bet.money,
        });
        await db.transactions.claim(reversal);
        await db.sql(
          `UPDATE wager_transactions SET status = ?, reference_transaction_id = ?${extra} WHERE id = ?`,
          [status, bet.id, reversal.id],
        );
        expect(await db.transactions.hasProcessedReversal(bet.id)).toBe(false);
      }
    });
  });

  describe("claimDue (lease + SKIP LOCKED) e wakeDependents", () => {
    const pending = async (w: Wallet, ref: string, due: number) => {
      const tx = newTx(db, w, { kind: Kind.Refund, referenceExternalTransactionId: ref });
      await db.uow.run(async () => {
        await db.transactions.claim(tx);
        tx.markPendingReference(at(due));
        await db.transactions.update(tx, at(1));
      });
      return tx;
    };

    test("exige transação", async () => {
      await expect(db.transactions.claimDue(at(100), 5, 1000)).rejects.toBeInstanceOf(
        NoTransactionError,
      );
    });

    test("só devolve vencidas, em ordem de vencimento, respeitando o limite", async () => {
      const w = await openWalletInDb(db, "10.00");
      const late = await pending(w, "r1", 500);
      const early = await pending(w, "r2", 100);
      const mid = await pending(w, "r3", 300);
      const future = await pending(w, "r4", 9_000);

      const claimed = await db.uow.run(() => db.transactions.claimDue(at(400), 10, 60_000));
      const mine = claimed
        .filter((t) => [late, early, mid, future].some((x) => x.id === t.id))
        .map((t) => t.id);
      expect(mine).toEqual([early.id, mid.id]); // 'late' (500) e 'future' ainda não venceram
      const limited = await db.uow.run(() => db.transactions.claimDue(at(10_000), 1, 60_000));
      expect(limited).toHaveLength(1);
    });

    test("o lease empurra next_attempt_at: nova reivindicação não pega a mesma linha", async () => {
      const w = await openWalletInDb(db, "10.00");
      const tx = await pending(w, "lease-ref", 100);
      const first = await db.uow.run(() => db.transactions.claimDue(at(200), 1000, 60_000));
      expect(first.map((t) => t.id)).toContain(tx.id);
      expect((await db.transactions.findById(tx.id))?.nextAttemptAt?.toISOString()).toBe(
        at(260).toISOString(),
      );
      const second = await db.uow.run(() => db.transactions.claimDue(at(230), 1000, 60_000));
      expect(second.map((t) => t.id)).not.toContain(tx.id);
      const third = await db.uow.run(() => db.transactions.claimDue(at(261), 1000, 60_000));
      expect(third.map((t) => t.id)).toContain(tx.id); // lease expirou: outro worker pode assumir
    });

    test("workers concorrentes nunca reivindicam a mesma linha (SKIP LOCKED)", async () => {
      const w = await openWalletInDb(db, "10.00");
      const created: string[] = [];
      for (let i = 0; i < 12; i++) created.push((await pending(w, `par-${i}`, 100)).id);

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          db.uow.run(async () => {
            const got = await db.transactions.claimDue(at(1_000), 4, 60_000);
            await new Promise((r) => setTimeout(r, 50)); // segura o lock para forçar sobreposição
            return got.map((t) => t.id);
          }),
        ),
      );
      const flat = results.flat().filter((id) => created.includes(id));
      expect(new Set(flat).size).toBe(flat.length); // nenhum duplicado
      expect(flat.length).toBe(12); // e nenhuma ficou para trás
    });

    test("claimDue ignora transações que não estão em PENDING_REFERENCE", async () => {
      const w = await openWalletInDb(db, "100.00");
      const processed = newTx(db, w);
      await applyInDb(db, processed);
      const claimed = await db.uow.run(() => db.transactions.claimDue(at(100_000), 1000, 1000));
      expect(claimed.map((t) => t.id)).not.toContain(processed.id);
    });

    test("wakeDependents torna vencidas só as que aguardam aquele (provedor, id externo)", async () => {
      const w = await openWalletInDb(db, "10.00");
      const waiting = await pending(w, "bet-wake", 9_000);
      const other = await pending(w, "outra-ref", 9_000);
      expect(await db.transactions.wakeDependents("provider-b", "bet-wake", at(50))).toBe(0);
      expect(await db.transactions.wakeDependents("provider-a", "bet-wake", at(50))).toBe(1);
      expect((await db.transactions.findById(waiting.id))?.nextAttemptAt?.toISOString()).toBe(
        at(50).toISOString(),
      );
      expect((await db.transactions.findById(other.id))?.nextAttemptAt?.toISOString()).toBe(
        at(9_000).toISOString(),
      );
      expect(await db.transactions.wakeDependents("provider-a", "bet-wake", at(50))).toBe(0); // já vencida
    });

    test("limit e lease inválidos são recusados", async () => {
      await db.uow.run(async () => {
        await expect(db.transactions.claimDue(at(1), 0, 1000)).rejects.toBeInstanceOf(
          InvalidArgumentError,
        );
        await expect(db.transactions.claimDue(at(1), 1, 0)).rejects.toBeInstanceOf(
          InvalidArgumentError,
        );
      });
    });
  });
});

describe("InboxRepository", () => {
  const message = (
    consumer = "wager-processor",
    id = `msg-${db.ids.next()}`,
    hash = sha256Hex("x"),
  ) =>
    InboxMessage.receive({
      consumerName: consumer,
      messageId: id,
      payloadHash: hash,
      receivedAt: at(3),
    });

  test("tryReceive: primeira vez true, duplicata false (e não altera a original)", async () => {
    const first = message("c", "m-1", sha256Hex("a"));
    expect(await db.inbox.tryReceive(first)).toBe(true);
    const duplicate = message("c", "m-1", sha256Hex("diferente"));
    expect(await db.inbox.tryReceive(duplicate)).toBe(false);
    expect((await db.inbox.find("c", "m-1"))?.payloadHash).toBe(sha256Hex("a"));
  });

  test("o mesmo messageId em outro consumidor é independente", async () => {
    expect(await db.inbox.tryReceive(message("c-a", "same"))).toBe(true);
    expect(await db.inbox.tryReceive(message("c-b", "same"))).toBe(true);
  });

  test("find inexistente → null; markProcessed persiste e não repete", async () => {
    expect(await db.inbox.find("c", "nope")).toBeNull();
    const m = message();
    await db.inbox.tryReceive(m);
    m.markProcessed(at(4));
    await db.inbox.markProcessed(m);
    const loaded = await db.inbox.find(m.consumerName, m.messageId);
    expect(loaded?.isProcessed()).toBe(true);
    expect(loaded?.processedAt?.toISOString()).toBe(at(4).toISOString());
    await expect(db.inbox.markProcessed(m)).rejects.toBeInstanceOf(OptimisticLockError);
  });

  test("duplicatas concorrentes: exatamente uma vence", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        db.uow.run(() => db.inbox.tryReceive(message("race", "same-msg"))),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("tryReceive dentro de transação revertida não deixa rastro", async () => {
    const m = message();
    await db.uow
      .run(async () => {
        await db.inbox.tryReceive(m);
        throw new Error("abort");
      })
      .catch(() => undefined);
    expect(await db.inbox.find(m.consumerName, m.messageId)).toBeNull();
  });
});

describe("OutboxRepository", () => {
  const enqueue = async (due?: number, group = "wallet-x") => {
    const wallet = await openWalletInDb(db, "0.00");
    const tx = newTx(db, wallet);
    tx.markProcessed(undefined, at(1), brl("1.00"));
    const event = WagerTransactionProcessed.from(
      tx,
      eventContext({ eventId: db.ids.next(), occurredAt: at(due ?? 0) }),
    );
    const message = OutboxMessage.enqueue(event, group);
    await db.outbox.add(message);
    return message;
  };

  test("add + findById preservam o envelope (jsonb) e os campos", async () => {
    const message = await enqueue(5);
    const loaded = await db.outbox.findById(message.id);
    expect(loaded?.eventType).toBe("WagerTransactionProcessed");
    expect(loaded?.messageGroupId).toBe("wallet-x");
    expect(loaded?.payload).toEqual(message.payload);
    const payload = present(loaded).payload as { data: { money: { amount: string } } };
    expect(payload.data.money.amount).toBe("10.00");
    expect(loaded?.attempts).toBe(0);
    expect(loaded?.isDue(at(5))).toBe(true);
    expect(loaded?.lastError).toBeUndefined();
  });

  test("findById inexistente → null", async () => {
    expect(await db.outbox.findById(db.ids.next())).toBeNull();
  });

  test("add dentro de transação revertida não deixa rastro (atomicidade com a mudança financeira)", async () => {
    let id = "";
    await db.uow
      .run(async () => {
        const wallet = await openWalletInDb(db, "0.00");
        const tx = newTx(db, wallet);
        tx.markProcessed(undefined, at(1), brl("1.00"));
        const message = OutboxMessage.enqueue(
          WagerTransactionProcessed.from(tx, eventContext({ eventId: db.ids.next() })),
          "g",
        );
        id = message.id;
        await db.outbox.add(message);
        throw new Error("abort");
      })
      .catch(() => undefined);
    expect(await db.outbox.findById(id)).toBeNull();
  });

  test("claimDue exige transação, devolve só vencidas em ordem de occurredAt e aplica lease", async () => {
    await expect(db.outbox.claimDue(at(9999), 5, 1000)).rejects.toBeInstanceOf(NoTransactionError);
    const second = await enqueue(2_002);
    const first = await enqueue(2_001);
    const future = await enqueue(9_999_000);
    const claimed = await db.uow.run(() => db.outbox.claimDue(at(2_100), 100, 30_000));
    const mine = claimed
      .map((m) => m.id)
      .filter((id) => [first.id, second.id, future.id].includes(id));
    expect(mine).toEqual([first.id, second.id]);
    expect((await db.outbox.findById(first.id))?.nextAttemptAt.toISOString()).toBe(
      at(2_130).toISOString(),
    );
    const again = await db.uow.run(() => db.outbox.claimDue(at(2_110), 100, 30_000));
    expect(again.map((m) => m.id)).not.toContain(first.id);
  });

  test("publishers concorrentes nunca recebem a mesma mensagem", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await enqueue(3_000 + i)).id);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        db.uow.run(async () => {
          const got = await db.outbox.claimDue(at(4_000), 4, 60_000);
          await new Promise((r) => setTimeout(r, 50));
          return got.map((m) => m.id);
        }),
      ),
    );
    const flat = results.flat().filter((id) => ids.includes(id));
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat.length).toBe(12);
  });

  test("markPublished retira da fila e não pode repetir", async () => {
    const message = await enqueue(5_000);
    message.markPublished(at(5_001));
    await db.outbox.markPublished(message);
    const loaded = await db.outbox.findById(message.id);
    expect(loaded?.isPending()).toBe(false);
    expect(loaded?.publishedAt?.toISOString()).toBe(at(5_001).toISOString());
    const claimed = await db.uow.run(() => db.outbox.claimDue(at(99_999), 1000, 1000));
    expect(claimed.map((m) => m.id)).not.toContain(message.id);
    await expect(db.outbox.markPublished(message)).rejects.toBeInstanceOf(OptimisticLockError);
  });

  test("saveRetry persiste tentativas, próximo horário e motivo; não vale para publicada", async () => {
    const message = await enqueue(6_000);
    message.scheduleRetry(at(6_010), { reason: "sqs indisponível" });
    await db.outbox.saveRetry(message);
    const loaded = await db.outbox.findById(message.id);
    expect(loaded?.attempts).toBe(1);
    expect(loaded?.lastError).toBe("sqs indisponível");
    expect(loaded?.nextAttemptAt.toISOString()).toBe(at(6_011).toISOString());

    loaded?.markPublished(at(6_020));
    await db.outbox.markPublished(loaded as OutboxMessage);
    await expect(db.outbox.saveRetry(message)).rejects.toBeInstanceOf(OptimisticLockError);
  });

  test("limit e lease inválidos são recusados", async () => {
    await db.uow.run(async () => {
      await expect(db.outbox.claimDue(at(1), 0, 1000)).rejects.toBeInstanceOf(InvalidArgumentError);
      await expect(db.outbox.claimDue(at(1), 1, 0)).rejects.toBeInstanceOf(InvalidArgumentError);
    });
  });
});

describe("ciclo completo sobre o banco real", () => {
  test("abertura → BET → WIN → LOSS → REFUND → ROLLBACK mantém saldo == Σ ledger", async () => {
    const wallet = await openWalletInDb(db, "100.00");
    const bet = newTx(db, wallet, { money: brl("30.00") });
    const win = newTx(db, wallet, {
      kind: Kind.Win,
      money: brl("50.00"),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const loss = newTx(db, wallet, {
      kind: Kind.Loss,
      money: brl("0.00"),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const bet2 = newTx(db, wallet, { money: brl("20.00") });
    const refund = newTx(db, wallet, {
      kind: Kind.Refund,
      money: brl("20.00"),
      referenceExternalTransactionId: bet2.externalTransactionId,
    });
    const rollback = newTx(db, wallet, {
      kind: Kind.Rollback,
      money: brl("50.00"),
      referenceExternalTransactionId: win.externalTransactionId,
    });

    const balances: string[] = [];
    for (const tx of [bet, win, loss, bet2, refund, rollback]) {
      const result = await applyInDb(db, tx);
      expect(result.status).toBe(Status.Processed);
      balances.push(result.balance.toString());
    }
    expect(balances).toEqual([
      "70.00 BRL",
      "120.00 BRL",
      "120.00 BRL",
      "100.00 BRL",
      "120.00 BRL",
      "70.00 BRL",
    ]);
    expect((await db.wallets.findById(wallet.id))?.version).toBe(1 + 5); // LOSS não move saldo
  });
});

/** Estado de uma transação carregada, para forjar uma reidratação em teste. */
function snapshot(tx: import("../../../src/wagering/domain").WagerTransaction) {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    createdAt: tx.createdAt,
    status: tx.status,
    referenceTransactionId: tx.referenceTransactionId,
    failureCode: tx.failureCode,
    processedAt: tx.processedAt,
    observedBalance: tx.observedBalance,
    attempts: tx.attempts,
    nextAttemptAt: tx.nextAttemptAt,
  };
}
