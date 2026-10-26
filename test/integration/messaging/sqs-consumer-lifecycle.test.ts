import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  Disposition,
  IncomingMessage,
  MessageHandler,
} from "../../../src/messaging/application/ports/message-handler";
import { SqsConsumer } from "../../../src/messaging/infrastructure/sqs/sqs-consumer";
import { WagerMessageHandler } from "../../../src/wagering/interfaces/sqs/wager-message.handler";
import {
  type ConsumerHarness,
  startConsumerHarness,
  until,
  wagerMessage,
} from "../../support/consumer";
import { injectFailure, pgError } from "../../support/consumer-faults";
import { createTestDatabase, expectInvariants, type TestDatabase } from "../../support/database";
import { queueDepth, registryFor } from "../../support/messaging";
import { money } from "../../support/wagering-api";

/** Ordem por grupo, paralelismo entre wallets e desligamento (SIGTERM) do consumidor. */
let db: TestDatabase;
let h: ConsumerHarness;

async function boot(env: Record<string, string> = {}, roles = "api,consumer") {
  h = await startConsumerHarness(db, { roles, env });
}

beforeEach(async () => {
  db = await createTestDatabase({ poolMax: 50 });
});
afterEach(async () => {
  await h?.close();
  await expectInvariants(db);
  await db.close();
});

const settled = () => until(() => h.inputIsEmpty(), 30_000, "fila de entrada vazia");

const ledgerAmounts = async (walletId: string): Promise<string[]> =>
  (
    await db.sql<{ amount: string }[]>(
      "SELECT amount FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT' ORDER BY seq",
      [walletId],
    )
  ).map((r) => r.amount);

const countWhere = async (where: string, params: unknown[] = []): Promise<number> =>
  Number(
    (
      await db.sql<{ n: string }[]>(
        `SELECT count(*)::text AS n FROM wager_transactions WHERE ${where}`,
        params,
      )
    )[0]?.n,
  ); // allow-number: contagem

/** Handler real com atraso/pausa controlados, para segurar mensagens "em andamento". */
function slowHandler(delayMs: number) {
  const real = h.api.app.get(WagerMessageHandler);
  const stats = { started: 0, finished: 0 };
  const handler: MessageHandler = {
    async handle(message: IncomingMessage): Promise<Disposition> {
      stats.started++;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const result = await real.handle(message);
      stats.finished++;
      return result;
    },
  };
  return { handler, stats };
}

function standaloneConsumer(handler: MessageHandler, overrides: { shutdownGraceMs?: number } = {}) {
  return new SqsConsumer(h.sqs, registryFor(h.sqs, h.prefix), handler, {
    pollers: 1,
    batchSize: 10,
    waitSeconds: 1,
    shutdownGraceMs: overrides.shutdownGraceMs ?? 15_000,
    retryDelaySeconds: () => 0,
  });
}

describe("ordem e paralelismo", () => {
  test("mensagens do mesmo grupo são aplicadas em ordem", async () => {
    await boot();
    const wallet = await h.w.createWallet("1000.00");
    const amounts = ["10.00", "20.00", "30.00", "40.00", "50.00", "60.00"];
    for (const [i, amount] of amounts.entries()) {
      await h.send(
        wagerMessage(h.w, wallet, { money: money(amount), externalTransactionId: `o${i}` }),
      );
    }

    await settled();

    expect(await ledgerAmounts(wallet.id)).toEqual(amounts);
    expect(await h.w.balanceOf(wallet.id)).toBe("790.00");
  });

  test("um retry no meio do grupo não deixa as seguintes passarem na frente", async () => {
    await boot();
    const wallet = await h.w.createWallet("1000.00");
    const amounts = ["10.00", "20.00", "30.00", "40.00"];
    // Só a 1ª chamada (a mensagem de 10.00) falha, de forma transitória.
    const fault = injectFailure(h, (call) => (call === 1 ? pgError("57P03") : null));
    for (const [i, amount] of amounts.entries()) {
      await h.send(
        wagerMessage(h.w, wallet, { money: money(amount), externalTransactionId: `o${i}` }),
      );
    }

    await settled();

    expect(fault.calls()).toBeGreaterThanOrEqual(5);
    expect(await ledgerAmounts(wallet.id)).toEqual(amounts);
  });

  test("15 wallets × 4 mensagens em paralelo: cada saldo exato", async () => {
    await boot();
    const wallets = await Promise.all(Array.from({ length: 15 }, () => h.w.createWallet("500.00")));
    await Promise.all(
      wallets.flatMap((wallet) =>
        ["5.00", "10.00", "15.00", "20.00"].map((amount, i) =>
          h.send(
            wagerMessage(h.w, wallet, { money: money(amount), externalTransactionId: `p${i}` }),
          ),
        ),
      ),
    );

    await settled();

    for (const wallet of wallets) expect(await h.w.balanceOf(wallet.id)).toBe("450.00");
    expect(await countWhere("status = 'PROCESSED' AND kind = 'BET'")).toBe(60);
  });

  test("cenário obrigatório via SQS: 100,00 com 2 × 80,00 → uma PROCESSED, uma REJECTED, saldo 20,00", async () => {
    await boot();
    const wallet = await h.w.createWallet("100.00");

    await Promise.all(
      ["a", "b"].map((name) =>
        h.send(wagerMessage(h.w, wallet, { money: money("80.00"), externalTransactionId: name })),
      ),
    );
    await settled();

    expect(await h.w.balanceOf(wallet.id)).toBe("20.00");
    expect(
      await countWhere("wallet_id = ? AND status = 'PROCESSED' AND kind = 'BET'", [wallet.id]),
    ).toBe(1);
    expect(await countWhere("wallet_id = ? AND status = 'REJECTED'", [wallet.id])).toBe(1);
  });

  test("30 apostas de 10,00 contra 100,00: exatamente 10 passam", async () => {
    await boot();
    const wallet = await h.w.createWallet("100.00");

    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        h.send(
          wagerMessage(h.w, wallet, { money: money("10.00"), externalTransactionId: `m${i}` }),
        ),
      ),
    );
    await settled();

    expect(await h.w.balanceOf(wallet.id)).toBe("0.00");
    expect(
      await countWhere("wallet_id = ? AND status = 'PROCESSED' AND kind = 'BET'", [wallet.id]),
    ).toBe(10);
    expect(await countWhere("wallet_id = ? AND status = 'REJECTED'", [wallet.id])).toBe(20);
  });

  test("sem o papel consumer, nada é consumido", async () => {
    await boot({}, "api");
    const wallet = await h.w.createWallet("100.00");
    await h.send(
      wagerMessage(h.w, wallet, { money: money("10.00"), externalTransactionId: "idle" }),
    );

    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(await queueDepth(h.sqs, h.urls.transactions)).toBe(1);
    expect(await h.w.balanceOf(wallet.id)).toBe("100.00");
  });
});

describe("desligamento (SIGTERM)", () => {
  test("stop() espera as mensagens em andamento e devolve as não iniciadas", async () => {
    await boot({}, "api");
    const walletA = await h.w.createWallet("1000.00");
    const walletB = await h.w.createWallet("1000.00");
    for (const wallet of [walletA, walletB]) {
      for (let i = 0; i < 3; i++) {
        await h.send(
          wagerMessage(h.w, wallet, { money: money("10.00"), externalTransactionId: `s${i}` }),
        );
      }
    }

    const slow = slowHandler(1_200);
    const first = standaloneConsumer(slow.handler);
    first.start();
    await until(() => slow.stats.started >= 2, 20_000, "mensagens em andamento");
    await first.stop();

    // Tudo o que começou terminou (e foi apagado); nada ficou pela metade.
    expect(slow.stats.finished).toBe(slow.stats.started);
    const doneByFirst = await countWhere("kind = 'BET' AND status = 'PROCESSED'");
    expect(doneByFirst).toBe(slow.stats.finished);
    expect(doneByFirst).toBeLessThan(6); // as não iniciadas foram devolvidas, não processadas
    expect(await queueDepth(h.sqs, h.urls.transactions)).toBe(6 - doneByFirst);

    // Outra instância assume o resto: cada mensagem tem efeito exatamente uma vez.
    const second = standaloneConsumer(h.api.app.get(WagerMessageHandler));
    second.start();
    await settled();
    await second.stop();

    expect(await h.w.balanceOf(walletA.id)).toBe("970.00");
    expect(await h.w.balanceOf(walletB.id)).toBe("970.00");
    expect(await countWhere("kind = 'BET' AND status = 'PROCESSED'")).toBe(6);
  });

  test("passado o prazo de graça, o que não terminou volta à fila na hora", async () => {
    await boot({}, "api");
    const wallet = await h.w.createWallet("100.00");
    await h.send(
      wagerMessage(h.w, wallet, { money: money("25.00"), externalTransactionId: "hang" }),
    );

    let started = false;
    const hanging: MessageHandler = {
      handle: () => {
        started = true;
        return new Promise<Disposition>(() => {}); // nunca termina
      },
    };
    const consumer = standaloneConsumer(hanging, { shutdownGraceMs: 300 });
    consumer.start();
    await until(() => started, 20_000, "handler iniciado");

    const before = Date.now();
    await consumer.stop();
    expect(Date.now() - before).toBeLessThan(5_000);

    // Devolvida com visibilidade 0: outra instância a pega sem esperar o timeout de 30 s.
    const next = standaloneConsumer(h.api.app.get(WagerMessageHandler));
    next.start();
    await settled();
    await next.stop();
    expect(await h.w.balanceOf(wallet.id)).toBe("75.00");
  });

  test("encerrar o app com mensagem em andamento: conclui o commit e dá o ack antes de fechar", async () => {
    await boot();
    const wallet = await h.w.createWallet("100.00");
    const real = h.api.app.get(WagerMessageHandler);
    let started = false;
    const original = real.handle.bind(real);
    real.handle = async (message) => {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return original(message);
    };
    await h.send(
      wagerMessage(h.w, wallet, { money: money("40.00"), externalTransactionId: "term" }),
    );
    await until(() => started, 20_000, "handler iniciado");

    await h.api.close(); // o que o SIGTERM dispara (enableShutdownHooks)

    // O banco ainda estava aberto durante o handler: o efeito foi commitado e a mensagem apagada.
    expect(await h.w.balanceOf(wallet.id)).toBe("60.00");
    expect(await queueDepth(h.sqs, h.urls.transactions)).toBe(0);
  });
});
