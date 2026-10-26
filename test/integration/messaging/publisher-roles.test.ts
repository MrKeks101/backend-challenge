import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestDatabase, expectInvariants, type TestDatabase } from "../../support/database";
import { startApi, type TestApi } from "../../support/http-app";
import {
  DEAD_SQS_ENDPOINT,
  drainQueue,
  enqueueEvent,
  queueDepth,
  registryFor,
  sqsClient,
  uniquePrefix,
  unpublishedCount,
} from "../../support/messaging";
import { openWalletInDb } from "../../support/persisted-flow";
import { money, WageringApi } from "../../support/wagering-api";

/**
 * Ponta a ponta: API real + publisher ligado por `APP_ROLES`, publicando no SQS real. Prova que
 * o evento nasce na MESMA transação financeira e chega à fila depois do commit.
 */
let db: TestDatabase;
let api: TestApi | undefined;
const sqs = sqsClient();

beforeEach(async () => {
  db = await createTestDatabase({ poolMax: 30 });
});
afterEach(async () => {
  await expectInvariants(db);
  await api?.close();
  api = undefined;
  await db.close();
});

/** Espera uma condição de fato (sem tempo fixo): consulta até valer ou estourar o prazo. */
async function until(condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condição não atingida no prazo");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("APP_ROLES", () => {
  test("api + publisher: a aposta gera eventos que chegam ao wager-events.fifo", async () => {
    const prefix = uniquePrefix();
    api = await startApi(db, {
      roles: "api,publisher",
      env: { SQS_QUEUE_PREFIX: prefix, OUTBOX_POLL_INTERVAL_MS: "50" },
    });
    const w = new WageringApi(api, db);
    const wallet = await w.createWallet("100.00");

    const { res } = await w.send(wallet, { money: money("30.00") });
    expect(res.status).toBe(200);

    await until(async () => (await unpublishedCount(db)) === 0);
    const { events } = await registryFor(sqs, prefix).ensure();
    const received = await drainQueue(sqs, events);

    // Abertura da wallet (OPENING) + a aposta: cada uma gera Processed e BalanceChanged.
    expect(received.map((r) => r.eventType).sort()).toEqual([
      "WagerTransactionProcessed",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      "WalletBalanceChanged",
    ]);
    expect(
      received.some(
        (r) =>
          r.eventType === "WagerTransactionProcessed" &&
          r.body.aggregateId === res.body.transactionId,
      ),
    ).toBe(true);
    for (const event of received) {
      expect(event.groupId).toBe(wallet.id);
      expect(event.body.eventType).toBe(event.eventType);
      expect(event.body.eventId).toBe(event.eventId);
    }
    expect(await w.balanceOf(wallet.id)).toBe("70.00");
  });

  test("só api: grava na outbox mas não publica nada", async () => {
    const prefix = uniquePrefix();
    api = await startApi(db, { roles: "api", env: { SQS_QUEUE_PREFIX: prefix } });
    const w = new WageringApi(api, db);
    const wallet = await w.createWallet("100.00");
    const { res } = await w.send(wallet, { money: money("30.00") });
    expect(res.status).toBe(200);

    // Se um laço estivesse ligado, o intervalo padrão (500 ms) já o teria esvaziado.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(await unpublishedCount(db)).toBe(4); // abertura (2) + aposta (2)
    const { events } = await registryFor(sqs, prefix).ensure();
    expect(await queueDepth(sqs, events)).toBe(0);
  });

  test("encerrar a app para o publisher sem deixar ciclo pendurado", async () => {
    api = await startApi(db, {
      roles: "api,publisher",
      env: { SQS_QUEUE_PREFIX: uniquePrefix(), OUTBOX_POLL_INTERVAL_MS: "50" },
    });
    const w = new WageringApi(api, db);
    const wallet = await w.createWallet("100.00");
    await w.send(wallet, { money: money("10.00") });
    await until(async () => (await unpublishedCount(db)) === 0);

    await api.close(); // termina o ciclo em andamento antes de fechar banco e SQS
    api = undefined;

    // Depois do close nenhum ciclo roda: um evento novo, gravado agora, fica na outbox.
    await enqueueEvent(db, await openWalletInDb(db, "0.00"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await unpublishedCount(db)).toBe(1);
  });
});

describe("GET /health/ready", () => {
  test("PostgreSQL e SQS no ar: 200", async () => {
    api = await startApi(db);

    const res = await api.request("GET", "/health/ready");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", checks: { database: "up", sqs: "up" } });
  });

  test("SQS fora do ar: 503 apontando o SQS, e /health/live continua 200", async () => {
    api = await startApi(db, { env: { SQS_ENDPOINT: DEAD_SQS_ENDPOINT } });

    const ready = await api.request("GET", "/health/ready");
    const live = await api.request("GET", "/health/live");

    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ status: "unavailable", checks: { database: "up", sqs: "down" } });
    expect(live.status).toBe(200);
  });

  test("não exige autenticação e não vaza detalhes do erro", async () => {
    api = await startApi(db, { env: { SQS_ENDPOINT: DEAD_SQS_ENDPOINT } });

    const res = await api.request("GET", "/health/ready");

    expect(Object.keys(res.body).sort()).toEqual(["checks", "status"]);
    expect(JSON.stringify(res.body)).not.toContain("127.0.0.1");
  });
});
