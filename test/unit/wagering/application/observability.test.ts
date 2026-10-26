import { describe, expect, test } from "bun:test";
import { RequestContext } from "../../../../src/shared/application/request-context";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../../src/wagering/domain";
import { InMemoryWorld } from "../../../support/in-memory-world";
import { metricValue } from "../../../support/metrics";

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

const bet = (id = "bet-1") => command({ externalTransactionId: id });
const refund = (id = "refund-1", reference = "bet-1") =>
  command({
    externalTransactionId: id,
    kind: Kind.Refund,
    referenceExternalTransactionId: reference,
  });

describe("caminho HTTP (ProcessWagerTransactionUseCase.execute)", () => {
  test("conta a transação por status e tipo, mede a latência e o lock da wallet", async () => {
    const world = new InMemoryWorld();
    const { process } = world.build();

    await process.execute(bet(), { correlationId: "c" });

    const { app } = world.metrics;
    expect(
      await metricValue(app, "wager_transactions_total", { status: "PROCESSED", kind: "BET" }),
    ).toBe(1);
    expect(
      await metricValue(app, "wager_processing_duration_seconds_count", { source: "http" }),
    ).toBe(1);
    expect(await metricValue(app, "wallet_lock_wait_seconds_count")).toBe(1);
  });

  test("REJECTED e PENDING_REFERENCE contam nos seus status", async () => {
    const world = new InMemoryWorld({ balance: "10.00" });
    const { process } = world.build();

    await process.execute(bet(), { correlationId: "c" }); // saldo insuficiente
    await process.execute(refund("refund-1", "bet-nunca-chegou"), { correlationId: "c" });

    const { app } = world.metrics;
    expect(await metricValue(app, "wager_transactions_total", { status: "REJECTED" })).toBe(1);
    expect(
      await metricValue(app, "wager_transactions_total", {
        status: "PENDING_REFERENCE",
        kind: "REFUND",
      }),
    ).toBe(1);
  });

  test("replay da idempotency key conta duplicata e NÃO uma nova transação", async () => {
    const world = new InMemoryWorld();
    const { process } = world.build();

    await process.execute(bet(), { correlationId: "c1" });
    const replay = await process.execute(bet(), { correlationId: "c2" });

    expect(replay.idempotentReplay).toBe(true);
    const { app } = world.metrics;
    expect(await metricValue(app, "wager_duplicates_total", { source: "replay" })).toBe(1);
    expect(await metricValue(app, "wager_transactions_total")).toBe(1);
    expect(
      await metricValue(app, "wager_processing_duration_seconds_count", { source: "http" }),
    ).toBe(2);
  });

  test("erro de negócio (payload divergente) não conta transação nem duplicata", async () => {
    const world = new InMemoryWorld();
    const { process } = world.build();
    await process.execute(bet(), { correlationId: "c" });

    await expect(
      process.execute(
        { ...bet(), money: { amount: "26.00", currency: "BRL" } },
        { correlationId: "c" },
      ),
    ).rejects.toBeDefined();

    expect(await metricValue(world.metrics.app, "wager_transactions_total")).toBe(1);
    expect(await metricValue(world.metrics.app, "wager_duplicates_total")).toBe(0);
  });
});

describe("correlationId até o evento", () => {
  test("o correlationId recebido na borda vai em todos os eventos da transação", async () => {
    const world = new InMemoryWorld();
    const { process } = world.build();

    await process.execute(bet(), { correlationId: "http-header-id" });

    const correlations = world.outbox.messages.map((m) => m.payload.correlationId);
    expect(correlations.length).toBeGreaterThanOrEqual(2); // Processed + WalletBalanceChanged
    expect(new Set(correlations)).toEqual(new Set(["http-header-id"]));
  });

  test("o reprocessador usa `reprocessor:<id>` e os eventos o carregam", async () => {
    const world = new InMemoryWorld();
    const { process, reprocessor } = world.build();
    const pending = await process.execute(refund(), { correlationId: "c" });
    await process.execute(bet(), { correlationId: "c" });
    world.clock.advance(5 * SECOND);

    await reprocessor.runOnce();

    const processed = world.outbox.messages.filter(
      (m) => m.eventType === "WagerTransactionProcessed" && m.payload.correlationId !== "c",
    );
    expect(processed.map((m) => m.payload.correlationId)).toEqual([
      `reprocessor:${pending.transaction.id}`,
    ]);
  });

  test("o use case enriquece o contexto de log com transactionId, walletId e providerId", async () => {
    const world = new InMemoryWorld();
    const { process } = world.build();
    let seen: Record<string, unknown> = {};

    await RequestContext.run({ correlationId: "c" }, async () => {
      const result = await process.execute(bet(), { correlationId: "c" });
      seen = { ...RequestContext.current(), expectedTransactionId: result.transaction.id };
    });

    expect(seen).toMatchObject({
      correlationId: "c",
      walletId: "wallet-1",
      providerId: "provider-a",
    });
    expect(seen.transactionId).toBe(seen.expectedTransactionId);
  });

  test("replay: o contexto aponta para a transação ORIGINAL, não a descartada", async () => {
    const world = new InMemoryWorld();
    const { process } = world.build();
    const first = await process.execute(bet(), { correlationId: "c1" });
    let seen: string | undefined;

    await RequestContext.run({ correlationId: "c2" }, async () => {
      await process.execute(bet(), { correlationId: "c2" });
      seen = RequestContext.current().transactionId;
    });

    expect(seen).toBe(first.transaction.id);
  });
});

describe("reprocessador", () => {
  test("PROCESSED conta transação + latência; STILL_PENDING conta retry de espera", async () => {
    const world = new InMemoryWorld();
    const { process, reprocessor } = world.build();
    await process.execute(refund("refund-1", "bet-1"), { correlationId: "c" });
    world.clock.advance(5 * SECOND);

    const waiting = await reprocessor.runOnce();
    expect(waiting.results.STILL_PENDING).toBe(1);
    const { app } = world.metrics;
    expect(await metricValue(app, "wager_retries_total", { stage: "reference_wait" })).toBe(1);

    await process.execute(bet(), { correlationId: "c" });
    const resolved = await world.build().reprocessor.runOnce();
    expect(resolved.results.PROCESSED).toBe(1);
    expect(
      await metricValue(app, "wager_transactions_total", { status: "PROCESSED", kind: "REFUND" }),
    ).toBe(1);
    expect(
      await metricValue(app, "wager_processing_duration_seconds_count", { source: "reprocessor" }),
    ).toBe(2);
  });

  test("desistência conta REJECTED; NOOP não conta nada", async () => {
    const world = new InMemoryWorld({ policy: { maxAttempts: 1 } });
    const { process, reprocessor, reprocess } = world.build();
    const pending = await process.execute(refund(), { correlationId: "c" });
    world.clock.advance(5 * SECOND);

    await reprocessor.runOnce();
    expect(world.stateOf("refund-1")?.status).toBe(Status.Rejected);
    const { app } = world.metrics;
    expect(
      await metricValue(app, "wager_transactions_total", { status: "REJECTED", kind: "REFUND" }),
    ).toBe(1);

    const before = await metricValue(app, "wager_processing_duration_seconds_count", {
      source: "reprocessor",
    });
    await reprocess.execute(pending.transaction.id, { correlationId: "c" });
    await world.build().reprocessor.runOnce(); // nada vencido
    expect(
      await metricValue(app, "wager_processing_duration_seconds_count", { source: "reprocessor" }),
    ).toBe(before);
  });

  test("cada item roda no seu contexto de log (correlationId do reprocessador, ids da transação)", async () => {
    const world = new InMemoryWorld();
    const { process, reprocessor } = world.build();
    const pending = await process.execute(refund(), { correlationId: "c" });
    world.clock.advance(MINUTE);
    const seen: Record<string, unknown>[] = [];
    const original = world.transactions.findById.bind(world.transactions);
    world.transactions.findById = async (id: string) => {
      seen.push({ ...RequestContext.current() });
      return original(id);
    };

    await reprocessor.runOnce();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual({
      correlationId: `reprocessor:${pending.transaction.id}`,
      transactionId: pending.transaction.id,
      walletId: "wallet-1",
      providerId: "provider-a",
    });
    expect(RequestContext.current()).toEqual({});
  });
});
