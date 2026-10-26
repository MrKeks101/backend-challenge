import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ProcessWagerTransactionUseCase } from "../../../src/wagering/application/process-wager-transaction.use-case";
import {
  type ConsumerHarness,
  drainDlq,
  startConsumerHarness,
  until,
  wagerMessage,
} from "../../support/consumer";
import { injectFailure, pgError } from "../../support/consumer-faults";
import { createTestDatabase, expectInvariants, type TestDatabase } from "../../support/database";
import { money } from "../../support/wagering-api";

/** Falhas do consumidor: DLQ (permanente), retry com backoff (transitório) e esgotamento. */
let db: TestDatabase;
let h: ConsumerHarness;

beforeEach(async () => {
  db = await createTestDatabase({ poolMax: 40 });
  h = await startConsumerHarness(db);
});
afterEach(async () => {
  await h.close();
  await expectInvariants(db);
  await db.close();
});

const settled = () => until(() => h.inputIsEmpty(), 20_000, "fila de entrada vazia");

const txByExternalId = async (externalId: string) =>
  (
    await db.sql<Record<string, any>[]>(
      "SELECT * FROM wager_transactions WHERE external_transaction_id = ?",
      [externalId],
    )
  )[0];

const countRows = async (table: string): Promise<number> =>
  Number((await db.sql<{ n: string }[]>(`SELECT count(*)::text AS n FROM ${table}`))[0]?.n); // allow-number: contagem

describe("mensagem inválida → DLQ", () => {
  const wallet = async () => h.w.createWallet("100.00");

  test.each([
    ["JSON quebrado", () => "{ isto nao e json"],
    ["não é um objeto", () => "[]"],
    ["type errado", (m: any) => ({ ...m, type: "OutraCoisa" })],
    ["sem messageId", (m: any) => ({ ...m, messageId: undefined })],
    ["occurredAt inválido", (m: any) => ({ ...m, occurredAt: "ontem" })],
    ["sem idempotencyKey", (m: any) => ({ ...m, data: { ...m.data, idempotencyKey: undefined } })],
    ["kind OPENING", (m: any) => ({ ...m, data: { ...m.data, kind: "OPENING" } })],
    ["kind desconhecido", (m: any) => ({ ...m, data: { ...m.data, kind: "JACKPOT" } })],
    [
      "valor como número JSON",
      (m: any) => ({ ...m, data: { ...m.data, money: { amount: 5, currency: "BRL" } } }),
    ],
    ["walletId não é uuid", (m: any) => ({ ...m, data: { ...m.data, walletId: "w-1" } })],
    ["campo desconhecido em data", (m: any) => ({ ...m, data: { ...m.data, extra: 1 } })],
    ["campo desconhecido na raiz", (m: any) => ({ ...m, extra: 1 })],
  ])("%s", async (_label, mutate) => {
    const w = await wallet();
    const valid = wagerMessage(h.w, w, { externalTransactionId: "x1" });
    const broken = mutate(valid);

    await h.send(broken, { group: w.id });
    await settled();

    const [letter, ...rest] = await drainDlq(h.sqs, h.urls.transactionsDlq);
    expect(rest).toEqual([]);
    expect(letter?.attrs.errorReason).toBe("INVALID_MESSAGE");
    expect(letter?.attrs.errorDetail).toBeString();
    expect(letter?.attrs.receiveCount).toBe("1");
    expect(letter?.attrs.originalMessageId).toBeString();
    expect(letter?.attrs.failedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(letter?.body).toBe(typeof broken === "string" ? broken : JSON.stringify(broken));
    // Nada foi gravado: sem inbox, sem transação, saldo intacto.
    expect(await countRows("inbox_messages")).toBe(0);
    expect(await txByExternalId(valid.data.externalTransactionId as string)).toBeUndefined();
    expect(await h.w.balanceOf(w.id)).toBe("100.00");
  });

  test("o detalhe do erro não ecoa valores recebidos", async () => {
    const w = await wallet();
    const valid = wagerMessage(h.w, w, { externalTransactionId: "x1" });

    await h.send({
      ...valid,
      data: { ...valid.data, roundId: 12345, gameId: "segredo-do-jogador" },
    });
    await settled();

    const [letter] = await drainDlq(h.sqs, h.urls.transactionsDlq);
    expect(letter?.attrs.errorDetail).toContain("data.roundId");
    expect(letter?.attrs.errorDetail).not.toContain("12345");
  });

  test("wallet inexistente → DLQ WALLET_NOT_FOUND, sem inbox nem transação", async () => {
    const w = await wallet();
    const ghost = { ...w, id: "0192f291-27dd-7d3f-8071-5f8685deef37" };
    const message = wagerMessage(h.w, ghost, { externalTransactionId: "x1" });

    await h.send(message);
    await settled();

    const [letter] = await drainDlq(h.sqs, h.urls.transactionsDlq);
    expect(letter?.attrs.errorReason).toBe("WALLET_NOT_FOUND");
    expect(await countRows("inbox_messages")).toBe(0);
    expect(await countRows("wager_transactions")).toBe(1); // só a abertura da wallet real
  });

  test("mesma idempotency key com payload diferente → DLQ IDEMPOTENCY_KEY_CONFLICT", async () => {
    const w = await wallet();
    const first = wagerMessage(h.w, w, { money: money("10.00"), externalTransactionId: "k1" });
    const clash = wagerMessage(h.w, w, {
      money: money("55.00"),
      externalTransactionId: "k1",
      idempotencyKey: first.data.idempotencyKey as string,
    });

    await h.send(first);
    await until(async () => (await h.w.balanceOf(w.id)) === "90.00");
    await h.send(clash);
    await settled();

    const [letter] = await drainDlq(h.sqs, h.urls.transactionsDlq);
    expect(letter?.attrs.errorReason).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(await h.w.balanceOf(w.id)).toBe("90.00");
    expect(await countRows("inbox_messages")).toBe(1); // a do conflito deu rollback junto
  });

  test("mesmo externalTransactionId sob outra key → DLQ EXTERNAL_TRANSACTION_ID_CONFLICT", async () => {
    const w = await wallet();
    const first = wagerMessage(h.w, w, { money: money("10.00"), externalTransactionId: "e1" });
    const other = wagerMessage(h.w, w, {
      money: money("10.00"),
      externalTransactionId: "e1",
      idempotencyKey: "outra-key-diferente",
    });

    await h.send(first);
    await until(async () => (await h.w.balanceOf(w.id)) === "90.00");
    await h.send(other);
    await settled();

    const [letter] = await drainDlq(h.sqs, h.urls.transactionsDlq);
    expect(letter?.attrs.errorReason).toBe("EXTERNAL_TRANSACTION_ID_CONFLICT");
    expect(await h.w.balanceOf(w.id)).toBe("90.00");
  });

  test.each([
    ["3 casas decimais", "1.005"],
    ["valor negativo", "-5.00"],
    ["valor zero", "0.00"],
    ["texto", "abc"],
  ])(
    "valor inválido para o domínio (%s) → DLQ com o código do domínio, sem efeito",
    async (_l, amount) => {
      const w = await wallet();
      const message = wagerMessage(h.w, w, { money: money(amount), externalTransactionId: "m1" });

      await h.send(message);
      await settled();

      const [letter] = await drainDlq(h.sqs, h.urls.transactionsDlq);
      expect(letter?.attrs.errorReason).toBeString();
      expect(letter?.attrs.errorReason).not.toBe("INVALID_MESSAGE");
      expect(await countRows("inbox_messages")).toBe(0);
      expect(await h.w.balanceOf(w.id)).toBe("100.00");
    },
  );

  test("REFUND sem referência (malformada) → DLQ INVALID_WAGER_TRANSACTION", async () => {
    const w = await wallet();
    const message = wagerMessage(h.w, w, { kind: "REFUND", externalTransactionId: "r1" });

    await h.send(message);
    await settled();

    const [letter] = await drainDlq(h.sqs, h.urls.transactionsDlq);
    expect(letter?.attrs.errorReason).toBe("INVALID_WAGER_TRANSACTION");
  });

  test("a DLQ preserva o grupo (walletId) da mensagem original", async () => {
    const w = await wallet();
    await h.send(wagerMessage(h.w, w, { kind: "REFUND", externalTransactionId: "r1" }));
    await settled();

    const [letter] = await drainDlq(h.sqs, h.urls.transactionsDlq);
    expect(letter?.groupId).toBe(w.id);
  });
});

describe("erro transitório → retry com backoff", () => {
  test("falha 2 vezes e depois passa: processa uma única vez, sem DLQ", async () => {
    const w = await h.w.createWallet("100.00");
    const message = wagerMessage(h.w, w, { money: money("30.00"), externalTransactionId: "t1" });
    const fault = injectFailure(h, (call) => (call <= 2 ? pgError("57P03") : null));

    await h.send(message);
    await until(async () => (await h.w.balanceOf(w.id)) === "70.00", 20_000, "efeito após retries");
    await settled();

    expect(fault.calls()).toBe(3);
    expect(await h.w.ledgerCount(w.id)).toBe(2);
    expect(await countRows("inbox_messages")).toBe(1);
    expect(await drainDlq(h.sqs, h.urls.transactionsDlq)).toEqual([]);
  });

  test.each([
    ["deadlock (o UoW repete antes do consumidor)", "40P01"],
    ["banco reiniciando", "57P01"],
    ["conexão recusada", "ECONNREFUSED"],
    ["lock não disponível", "55P03"],
  ])("%s é transitório (não vai à DLQ no 1º erro)", async (_label, code) => {
    const w = await h.w.createWallet("100.00");
    const message = wagerMessage(h.w, w, { money: money("5.00"), externalTransactionId: "t1" });
    const fault = injectFailure(h, (call) => (call === 1 ? pgError(code) : null));

    await h.send(message);
    await until(async () => (await h.w.balanceOf(w.id)) === "95.00", 20_000, "efeito após retry");
    await settled();

    expect(fault.calls()).toBe(2);
    expect(await drainDlq(h.sqs, h.urls.transactionsDlq)).toEqual([]);
  });

  test("esgotando as tentativas: DLQ + FAILED(PROCESSING_RETRIES_EXHAUSTED) + evento", async () => {
    const w = await h.w.createWallet("100.00");
    const message = wagerMessage(h.w, w, { money: money("30.00"), externalTransactionId: "t1" });
    const fault = injectFailure(h, () => pgError("57P03"));

    await h.send(message);
    await settled();

    // 5 entregas (maxReceiveCount) e então DLQ explícita.
    expect(fault.calls()).toBe(5);
    const [letter, ...rest] = await drainDlq(h.sqs, h.urls.transactionsDlq);
    expect(rest).toEqual([]);
    expect(letter?.attrs.errorReason).toBe("PROCESSING_RETRIES_EXHAUSTED");
    expect(letter?.attrs.receiveCount).toBe("5");
    expect(letter?.body).toBe(JSON.stringify(message));

    const tx = await txByExternalId(message.data.externalTransactionId as string);
    expect(tx?.status).toBe("FAILED");
    expect(tx?.failure_code).toBe("PROCESSING_RETRIES_EXHAUSTED");
    expect(await h.w.eventTypes(tx?.id)).toEqual(["WagerTransactionFailed"]);
    expect(await h.w.balanceOf(w.id)).toBe("100.00");
    expect(await countRows("inbox_messages")).toBe(0);
  });

  test("depois de FAILED, o provedor vê o estado (GET) e o replay devolve 500 FAILED", async () => {
    const w = await h.w.createWallet("100.00");
    const message = wagerMessage(h.w, w, { money: money("30.00"), externalTransactionId: "t1" });
    injectFailure(h, () => pgError("57P03"));
    await h.send(message);
    await settled();
    const tx = await txByExternalId(message.data.externalTransactionId as string);

    const get = await h.api.request("GET", `/wagering/transactions/${tx?.id}`);
    expect(get.status).toBe(200);
    expect(get.body.status).toBe("FAILED");
    expect(get.body.failureCode).toBe("PROCESSING_RETRIES_EXHAUSTED");
  });
});

describe("erro permanente inesperado → DLQ imediata", () => {
  test("erro não classificado: DLQ no 1º erro (sem retry infinito) e FAILED auditável", async () => {
    const w = await h.w.createWallet("100.00");
    const message = wagerMessage(h.w, w, { money: money("30.00"), externalTransactionId: "p1" });
    const fault = injectFailure(h, () => new TypeError("bug inesperado"));

    await h.send(message);
    await settled();

    expect(fault.calls()).toBe(1);
    const [letter] = await drainDlq(h.sqs, h.urls.transactionsDlq);
    expect(letter?.attrs.errorReason).toBe("INTERNAL_PERMANENT_ERROR");
    expect(letter?.attrs.errorDetail).toBe("unclassified");
    const tx = await txByExternalId(message.data.externalTransactionId as string);
    expect(tx?.status).toBe("FAILED");
    expect(tx?.failure_code).toBe("INTERNAL_PERMANENT_ERROR");
    expect(await h.w.balanceOf(w.id)).toBe("100.00");
  });

  test("violação de constraint (SQLSTATE 23xxx) é permanente", async () => {
    const w = await h.w.createWallet("100.00");
    const message = wagerMessage(h.w, w, { externalTransactionId: "p1" });
    const fault = injectFailure(h, () => pgError("23514"));

    await h.send(message);
    await settled();

    expect(fault.calls()).toBe(1);
    const [letter] = await drainDlq(h.sqs, h.urls.transactionsDlq);
    expect(letter?.attrs.errorReason).toBe("INTERNAL_PERMANENT_ERROR");
    expect(letter?.attrs.errorDetail).toBe("sqlstate_23514");
  });

  test("se gravar o FAILED também falha, a mensagem ainda vai para a DLQ", async () => {
    const w = await h.w.createWallet("100.00");
    const message = wagerMessage(h.w, w, { externalTransactionId: "p1" });
    injectFailure(h, () => new TypeError("bug"));
    // Torna o best-effort impossível: o registro FAILED também quebra.
    const useCase = h.api.app.get(ProcessWagerTransactionUseCase);
    useCase.recordFailure = async () => {
      throw pgError("57P03");
    };

    await h.send(message);
    await settled();

    const [letter] = await drainDlq(h.sqs, h.urls.transactionsDlq);
    expect(letter?.attrs.errorReason).toBe("INTERNAL_PERMANENT_ERROR");
    expect(await txByExternalId(message.data.externalTransactionId as string)).toBeUndefined();
  });
});
