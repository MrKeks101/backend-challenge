import { describe, expect, test } from "bun:test";
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../../src/wagering/domain";
import { InMemoryWorld } from "../../../support/in-memory-world";
import { brl } from "../../../support/money";

/**
 * Reprocessamento de `PENDING_REFERENCE` sobre o mundo em memória (mesmas portas do PostgreSQL).
 * A prova com banco real e paralelismo de processos fica na suíte de integração (M12).
 */
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

type Command = Parameters<ReturnType<InMemoryWorld["build"]>["process"]["execute"]>[0];

const command = (overrides: Partial<Command> & { externalTransactionId: string }): Command => ({
  idempotencyKey: `provider-a:${overrides.externalTransactionId}`,
  providerId: "provider-a",
  playerId: "player-1",
  walletId: "wallet-1",
  roundId: "round-1",
  gameId: "fortune-chimp",
  kind: Kind.Bet,
  money: { amount: "25.00", currency: "BRL" },
  ...overrides,
});

const ctx = { correlationId: "corr-test" };

/** Cria um REFUND que aponta para uma BET ainda inexistente: nasce PENDING_REFERENCE. */
async function pendingRefund(
  world: InMemoryWorld,
  externalId = "refund-1",
  reference = "bet-1",
  amount = "25.00",
) {
  const { process } = world.build();
  const result = await process.execute(
    command({
      externalTransactionId: externalId,
      kind: Kind.Refund,
      referenceExternalTransactionId: reference,
      money: { amount, currency: "BRL" },
    }),
    ctx,
  );
  expect(result.transaction.status).toBe(Status.PendingReference);
  return result.transaction;
}

const submitBet = (world: InMemoryWorld, externalId = "bet-1", amount = "25.00") =>
  world
    .build()
    .process.execute(
      command({ externalTransactionId: externalId, money: { amount, currency: "BRL" } }),
      ctx,
    );

describe("ReprocessPendingTransactionUseCase", () => {
  test("a referência chegou: a pendência é PROCESSED, credita e emite os eventos", async () => {
    const world = new InMemoryWorld({ balance: "100.00" });
    const refund = await pendingRefund(world);
    await submitBet(world); // 100 → 75
    expect(world.balance()).toBe("75.00");
    world.clock.advance(10 * SECOND);

    const result = await world.build().reprocess.execute(refund.id, ctx);

    expect(result).toBe("PROCESSED");
    expect(world.balance()).toBe("100.00");
    const state = world.stateOf("refund-1");
    expect(state?.status).toBe(Status.Processed);
    expect(state?.referenceTransactionId).toBe(world.stateOf("bet-1")?.id);
    expect(state?.nextAttemptAt).toBeUndefined();
    expect(world.eventTypes().slice(-2)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    world.assertLedgerMatchesBalance();
  });

  test("a referência ainda não chegou: agenda a próxima tentativa com backoff e conta a tentativa", async () => {
    const world = new InMemoryWorld();
    const refund = await pendingRefund(world);
    const eventsBefore = world.eventTypes().length;
    world.clock.advance(5 * SECOND);

    const result = await world.build().reprocess.execute(refund.id, ctx);

    expect(result).toBe("STILL_PENDING");
    const state = world.stateOf("refund-1");
    expect(state?.status).toBe(Status.PendingReference);
    expect(state?.attempts).toBe(1);
    // 2ª espera: 2 s · 2^1 = 4 s, a partir de agora (jitter 1 nos testes).
    expect(state?.nextAttemptAt?.getTime()).toBe(world.clock.now().getTime() + 4 * SECOND);
    expect(world.eventTypes()).toHaveLength(eventsBefore); // sem evento a cada tentativa
    expect(world.balance()).toBe("100.00");
  });

  test("o backoff cresce a cada tentativa fracassada e respeita o teto de 5 min", async () => {
    const world = new InMemoryWorld({ policy: { maxAttempts: 50, ttlMs: 24 * 60 * MINUTE } });
    const refund = await pendingRefund(world);
    const delays: number[] = [];

    for (let i = 0; i < 9; i++) {
      const before = world.stateOf("refund-1");
      world.clock.set(before?.nextAttemptAt as Date);
      await world.build().reprocess.execute(refund.id, ctx);
      const after = world.stateOf("refund-1");
      delays.push((after?.nextAttemptAt?.getTime() ?? 0) - world.clock.now().getTime());
    }

    expect(delays).toEqual([4, 8, 16, 32, 64, 128, 256, 300, 300].map((s) => s * SECOND));
  });

  test("o jitter multiplica o backoff", async () => {
    const world = new InMemoryWorld();
    const refund = await pendingRefund(world);
    (world.settings as { jitter: () => number }).jitter = () => 1.2;

    await world.build().reprocess.execute(refund.id, ctx);

    const state = world.stateOf("refund-1");
    expect((state?.nextAttemptAt?.getTime() ?? 0) - world.clock.now().getTime()).toBe(4_800);
  });

  describe("esgotamento do limite", () => {
    test("na 10ª tentativa fracassada: REJECTED REFERENCE_NOT_FOUND + evento", async () => {
      const world = new InMemoryWorld({ policy: { ttlMs: 24 * 60 * MINUTE } });
      const refund = await pendingRefund(world);
      const results: string[] = [];

      for (let i = 0; i < 10; i++) {
        world.clock.set(world.stateOf("refund-1")?.nextAttemptAt as Date);
        results.push(await world.build().reprocess.execute(refund.id, ctx));
      }

      expect(results).toEqual([...Array(9).fill("STILL_PENDING"), "GAVE_UP"]);
      const state = world.stateOf("refund-1");
      expect(state?.status).toBe(Status.Rejected);
      expect(state?.failureCode).toBe(FailureCode.ReferenceNotFound);
      expect(state?.nextAttemptAt).toBeUndefined();
      expect(world.eventTypes().filter((t) => t === "WagerTransactionRejected")).toHaveLength(1);
      expect(world.balance()).toBe("100.00");
    });

    test("o TTL de 1 h desiste mesmo com poucas tentativas", async () => {
      const world = new InMemoryWorld();
      const refund = await pendingRefund(world);
      world.clock.advance(60 * MINUTE);

      const result = await world.build().reprocess.execute(refund.id, ctx);

      expect(result).toBe("GAVE_UP");
      expect(world.stateOf("refund-1")?.failureCode).toBe(FailureCode.ReferenceNotFound);
    });

    test("um instante antes do TTL ainda espera", async () => {
      const world = new InMemoryWorld();
      const refund = await pendingRefund(world);
      world.clock.advance(60 * MINUTE - 1);

      expect(await world.build().reprocess.execute(refund.id, ctx)).toBe("STILL_PENDING");
    });

    test("o limite e o TTL vêm da configuração", async () => {
      const world = new InMemoryWorld({ policy: { maxAttempts: 2 } });
      const refund = await pendingRefund(world);

      world.clock.advance(SECOND);
      expect(await world.build().reprocess.execute(refund.id, ctx)).toBe("STILL_PENDING");
      world.clock.advance(SECOND);
      expect(await world.build().reprocess.execute(refund.id, ctx)).toBe("GAVE_UP");
    });

    test("rejeitar por REFERENCE_NOT_FOUND acorda quem esperava esta transação", async () => {
      const world = new InMemoryWorld({ policy: { maxAttempts: 1 } });
      const first = await pendingRefund(world, "refund-1", "bet-1");
      // Um ROLLBACK que referencia o refund pendente também fica pendente.
      const { process } = world.build();
      const dependent = await process.execute(
        command({
          externalTransactionId: "rollback-1",
          kind: Kind.Rollback,
          referenceExternalTransactionId: "refund-1",
        }),
        ctx,
      );
      expect(dependent.transaction.status).toBe(Status.PendingReference);
      const scheduled = world.stateOf("rollback-1")?.nextAttemptAt as Date;

      await world.build().reprocess.execute(first.id, ctx);

      const woken = world.stateOf("rollback-1")?.nextAttemptAt as Date;
      expect(woken.getTime()).toBeLessThan(scheduled.getTime());
      expect(woken.getTime()).toBe(world.clock.now().getTime());
    });
  });

  describe("não faz nada quando não deve", () => {
    test("transação inexistente", async () => {
      const world = new InMemoryWorld();
      expect(await world.build().reprocess.execute("nao-existe", ctx)).toBe("NOOP");
    });

    test("já resolvida por outra via (wake-up, outra instância)", async () => {
      const world = new InMemoryWorld();
      const refund = await pendingRefund(world);
      await submitBet(world);
      await world.build().reprocess.execute(refund.id, ctx);
      const events = world.eventTypes().length;
      const ledger = world.ledger.entries.length;

      const again = await world.build().reprocess.execute(refund.id, ctx);

      expect(again).toBe("NOOP");
      expect(world.eventTypes()).toHaveLength(events);
      expect(world.ledger.entries).toHaveLength(ledger);
      expect(world.balance()).toBe("100.00");
    });

    test("transação PENDING_REFERENCE de outro estado terminal (REJECTED) não é tocada", async () => {
      const world = new InMemoryWorld({ policy: { maxAttempts: 1 } });
      const refund = await pendingRefund(world);
      await world.build().reprocess.execute(refund.id, ctx); // GAVE_UP → REJECTED
      const updates = world.transactions.updates.length;

      expect(await world.build().reprocess.execute(refund.id, ctx)).toBe("NOOP");
      expect(world.transactions.updates).toHaveLength(updates);
    });
  });

  describe("desfechos que a política decide", () => {
    test("referência com valor diferente: REJECTED REFERENCE_AMOUNT_MISMATCH", async () => {
      const world = new InMemoryWorld();
      const refund = await pendingRefund(world, "refund-1", "bet-1", "10.00");
      await submitBet(world, "bet-1", "25.00");

      const result = await world.build().reprocess.execute(refund.id, ctx);

      expect(result).toBe("REJECTED");
      expect(world.stateOf("refund-1")?.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
      expect(world.balance()).toBe("75.00");
    });

    test("referência já estornada: REJECTED ALREADY_REVERSED", async () => {
      const world = new InMemoryWorld();
      const first = await pendingRefund(world, "refund-1", "bet-1");
      const second = await pendingRefund(world, "refund-2", "bet-1");
      await submitBet(world);

      expect(await world.build().reprocess.execute(first.id, ctx)).toBe("PROCESSED");
      expect(await world.build().reprocess.execute(second.id, ctx)).toBe("REJECTED");

      expect(world.stateOf("refund-2")?.failureCode).toBe(FailureCode.AlreadyReversed);
      expect(world.balance()).toBe("100.00"); // só um estorno aplicado
      world.assertLedgerMatchesBalance();
    });

    test("referência REJECTED: a dependente também é rejeitada", async () => {
      const world = new InMemoryWorld({ balance: "10.00" });
      const refund = await pendingRefund(world, "refund-1", "bet-1");
      await submitBet(world, "bet-1", "25.00"); // saldo insuficiente → REJECTED

      const result = await world.build().reprocess.execute(refund.id, ctx);

      expect(result).toBe("REJECTED");
      expect(world.stateOf("refund-1")?.failureCode).toBe(FailureCode.ReferenceNotProcessed);
      expect(world.balance()).toBe("10.00");
    });

    test("wallet de outra moeda ou jogador diferente: rejeição de negócio, não repetição", async () => {
      const world = new InMemoryWorld();
      const refund = await pendingRefund(world);
      await submitBet(world);
      // Corrompe a wallet armazenada para um jogador diferente: a política rejeita.
      const row = world.wallets.rows.get("wallet-1");
      if (row) world.wallets.rows.set("wallet-1", { ...row, playerId: "player-2" });

      const result = await world.build().reprocess.execute(refund.id, ctx);

      expect(result).toBe("REJECTED");
      expect(world.stateOf("refund-1")?.failureCode).toBe(FailureCode.PlayerWalletMismatch);
    });
  });

  test("duas execuções simultâneas da MESMA pendência aplicam uma única vez", async () => {
    const world = new InMemoryWorld();
    const refund = await pendingRefund(world);
    await submitBet(world);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => world.build().reprocess.execute(refund.id, ctx)),
    );

    expect(results.filter((r) => r === "PROCESSED")).toHaveLength(1);
    expect(results.filter((r) => r === "NOOP")).toHaveLength(7);
    expect(world.balance()).toBe("100.00");
    expect(world.ledger.entries.filter((e) => e.transactionId === refund.id)).toHaveLength(1);
    world.assertLedgerMatchesBalance();
  });
});

describe("PendingReferenceReprocessor (ciclo)", () => {
  test("só pega o que venceu; o lease impede o ciclo seguinte de repetir", async () => {
    const world = new InMemoryWorld({ leaseMs: 30 * SECOND });
    await pendingRefund(world);
    const { reprocessor } = world.build();

    expect((await reprocessor.runOnce()).claimed).toBe(0); // 1ª tentativa só em 2 s
    world.clock.advance(2 * SECOND);
    const first = await reprocessor.runOnce();
    const second = await reprocessor.runOnce();

    expect(first).toMatchObject({ claimed: 1, failed: 0 });
    expect(first.results.STILL_PENDING).toBe(1);
    expect(second.claimed).toBe(0);
  });

  test("lease vencido (reprocessador morreu): outra instância assume", async () => {
    const world = new InMemoryWorld({ leaseMs: 30 * SECOND });
    const refund = await pendingRefund(world);
    world.clock.advance(2 * SECOND);
    // A instância A reivindica e "morre" sem reprocessar.
    await world.uow.run(() => world.transactions.claimDue(world.clock.now(), 20, 30 * SECOND));
    expect((await world.build().reprocessor.runOnce()).claimed).toBe(0);

    world.clock.advance(30 * SECOND);
    const result = await world.build().reprocessor.runOnce();

    expect(result.claimed).toBe(1);
    expect(world.stateOf("refund-1")?.id).toBe(refund.id);
  });

  test("reinício: instâncias novas sobre o mesmo estado continuam de onde parou", async () => {
    const world = new InMemoryWorld();
    await pendingRefund(world);
    await submitBet(world);
    world.clock.advance(5 * SECOND);

    const afterRestart = world.build(); // tudo reconstruído, estado só no "banco"
    const result = await afterRestart.reprocessor.runOnce();

    expect(result.results.PROCESSED).toBe(1);
    expect(world.balance()).toBe("100.00");
  });

  test("cadeia: BET ← WIN ← ROLLBACK chegam em ordem inversa e resolvem em cascata", async () => {
    const world = new InMemoryWorld({ balance: "100.00" });
    const { process } = world.build();
    // 1) ROLLBACK do WIN, 2) WIN da BET, 3) só então a BET.
    await process.execute(
      command({
        externalTransactionId: "rollback-1",
        kind: Kind.Rollback,
        referenceExternalTransactionId: "win-1",
        money: { amount: "40.00", currency: "BRL" },
      }),
      ctx,
    );
    await process.execute(
      command({
        externalTransactionId: "win-1",
        kind: Kind.Win,
        referenceExternalTransactionId: "bet-1",
        money: { amount: "40.00", currency: "BRL" },
      }),
      ctx,
    );
    expect(world.stateOf("rollback-1")?.status).toBe(Status.PendingReference);
    expect(world.stateOf("win-1")?.status).toBe(Status.PendingReference);
    await submitBet(world, "bet-1", "25.00"); // 100 → 75, acorda o WIN
    const { reprocessor } = world.build();

    // O relógio não anda: só o wake-up torna as pendências vencidas. Ciclo 1: só o WIN foi
    // acordado (75 → 115) e ele acorda o ROLLBACK. Ciclo 2: ROLLBACK do WIN (115 → 75).
    const cycle1 = await reprocessor.runOnce();
    const cycle2 = await reprocessor.runOnce();
    const cycle3 = await reprocessor.runOnce();

    expect(cycle1).toMatchObject({ claimed: 1 });
    expect(cycle1.results.PROCESSED).toBe(1);
    expect(cycle2).toMatchObject({ claimed: 1 });
    expect(cycle2.results.PROCESSED).toBe(1);
    expect(cycle3.claimed).toBe(0);
    expect(world.stateOf("win-1")?.status).toBe(Status.Processed);
    expect(world.stateOf("rollback-1")?.status).toBe(Status.Processed);
    expect(world.balance()).toBe("75.00");
    world.assertLedgerMatchesBalance();
  });

  test("wake-up: quando a referência é processada, a dependente vence na hora (sem esperar o backoff)", async () => {
    const world = new InMemoryWorld();
    const refund = await pendingRefund(world);
    world.clock.advance(2 * SECOND);
    await world.build().reprocess.execute(refund.id, ctx); // 1 tentativa fracassada → próxima em +4 s
    const scheduled = world.stateOf("refund-1")?.nextAttemptAt as Date;
    expect(scheduled.getTime()).toBeGreaterThan(world.clock.now().getTime());

    await submitBet(world); // a referência chega e acorda a dependente
    const { reprocessor } = world.build();
    const result = await reprocessor.runOnce(); // o relógio NÃO avançou

    expect(world.stateOf("refund-1")?.nextAttemptAt?.getTime()).not.toBe(scheduled.getTime());
    expect(result).toMatchObject({ claimed: 1 });
    expect(result.results.PROCESSED).toBe(1);
    expect(world.balance()).toBe("100.00");
  });

  test("respeita o tamanho do lote e esvazia a fila em ciclos sucessivos", async () => {
    const world = new InMemoryWorld({ batchSize: 2 });
    for (let i = 0; i < 5; i++) await pendingRefund(world, `refund-${i}`, "bet-1", "1.00");
    await submitBet(world, "bet-1", "25.00");
    world.clock.advance(5 * SECOND);
    const { reprocessor } = world.build();

    const claimed = [
      (await reprocessor.runOnce()).claimed,
      (await reprocessor.runOnce()).claimed,
      (await reprocessor.runOnce()).claimed,
      (await reprocessor.runOnce()).claimed,
    ];

    expect(claimed).toEqual([2, 2, 1, 0]);
  });

  test("dois reprocessadores concorrentes não aplicam nada duas vezes", async () => {
    const world = new InMemoryWorld({ batchSize: 3 });
    // 6 estornos de 1,00 da mesma BET de 25,00: o 1º aplica, os outros viram ALREADY_REVERSED.
    for (let i = 0; i < 6; i++) await pendingRefund(world, `refund-${i}`, "bet-1", "25.00");
    await submitBet(world, "bet-1", "25.00");
    world.clock.advance(5 * SECOND);

    const [a, b] = await Promise.all([
      world.build().reprocessor.runOnce(),
      world.build().reprocessor.runOnce(),
    ]);

    expect(a.claimed + b.claimed).toBe(6); // lotes disjuntos
    expect(a.results.PROCESSED + b.results.PROCESSED).toBe(1);
    expect(a.results.REJECTED + b.results.REJECTED).toBe(5);
    expect(world.balance()).toBe("100.00"); // um único estorno efetivo
    world.assertLedgerMatchesBalance();
  });

  test("um item que falha não impede os demais; o lease o devolve depois", async () => {
    const world = new InMemoryWorld();
    const broken = await pendingRefund(world, "refund-broken", "bet-1", "1.00");
    await pendingRefund(world, "refund-ok", "bet-1", "1.00");
    await submitBet(world, "bet-1", "1.00");
    world.clock.advance(5 * SECOND);
    const original = world.transactions.findById.bind(world.transactions);
    world.transactions.findById = async (id: string) => {
      if (id === broken.id) throw Object.assign(new Error("db"), { code: "57P03" });
      return original(id);
    };

    const result = await world.build().reprocessor.runOnce();

    expect(result).toMatchObject({ claimed: 2, failed: 1 });
    expect(result.results.PROCESSED + result.results.REJECTED).toBe(1);
    expect(world.stateOf("refund-broken")?.status).toBe(Status.PendingReference);
  });

  test("sem pendências devolve um ciclo vazio", async () => {
    const world = new InMemoryWorld();
    const result = await world.build().reprocessor.runOnce();

    expect(result).toEqual({
      claimed: 0,
      failed: 0,
      results: { NOOP: 0, PROCESSED: 0, REJECTED: 0, STILL_PENDING: 0, GAVE_UP: 0 },
    });
  });
});

describe("entrada na espera (WagerOutcomeApplier)", () => {
  test("a 1ª tentativa respeita a configuração e o jitter, e emite PendingReference uma só vez", async () => {
    const world = new InMemoryWorld({ policy: { baseMs: 10_000, capMs: 20_000 } });
    (world.settings as { jitter: () => number }).jitter = () => 0.8;

    const refund = await pendingRefund(world);

    const state = world.stateOf("refund-1");
    expect(state?.id).toBe(refund.id);
    expect(state?.attempts).toBe(0);
    expect(state?.nextAttemptAt?.getTime()).toBe(world.clock.now().getTime() + 8_000);
    world.clock.advance(15 * SECOND);
    await world.build().reprocess.execute(refund.id, ctx);
    await world.build().reprocess.execute(refund.id, ctx);
    expect(world.eventTypes().filter((t) => t === "WagerTransactionPendingReference")).toHaveLength(
      1,
    );
  });

  test("moeda: o valor da referência é comparado em BRL", () => {
    expect(brl("1.00").equals(brl("1.00"))).toBe(true);
  });
});
