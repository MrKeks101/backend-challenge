import { describe, expect, test } from "bun:test";
import {
  InboxMessage,
  InvalidMessageStateError,
  OUTBOX_BACKOFF,
  OutboxMessage,
} from "../../../../src/messaging/domain";
import { InvalidArgumentError, sha256Hex } from "../../../../src/shared/kernel";
import { WagerTransactionProcessed } from "../../../../src/wagering/domain";
import { at, eventContext, makeProcessed } from "../../../support/wagering";

const HASH = sha256Hex("payload");

describe("InboxMessage", () => {
  const receive = () =>
    InboxMessage.receive({
      messageId: "m-1",
      consumerName: "wager-processor",
      payloadHash: HASH,
      receivedAt: at(1),
    });

  test("nasce não processada", () => {
    const m = receive();
    expect(m.isProcessed()).toBe(false);
    expect(m.processedAt).toBeUndefined();
    expect(m.receivedAt.toISOString()).toBe(at(1).toISOString());
  });

  test("markProcessed registra o instante e não pode ser repetido", () => {
    const m = receive();
    m.markProcessed(at(2));
    expect(m.isProcessed()).toBe(true);
    expect(m.processedAt?.toISOString()).toBe(at(2).toISOString());
    expect(() => m.markProcessed(at(3))).toThrow(InvalidMessageStateError);
    expect(m.processedAt?.toISOString()).toBe(at(2).toISOString());
  });

  test("data inválida não marca como processada", () => {
    const m = receive();
    expect(() => m.markProcessed(new Date("x"))).toThrow(InvalidArgumentError);
    expect(m.isProcessed()).toBe(false);
  });

  test("matchesPayload detecta mesma messageId com conteúdo diferente", () => {
    const m = receive();
    expect(m.matchesPayload(HASH)).toBe(true);
    expect(m.matchesPayload(sha256Hex("outro"))).toBe(false);
  });

  test.each([
    ["messageId", { messageId: "" }],
    ["consumerName", { consumerName: " " }],
    ["payloadHash vazio", { payloadHash: "" }],
    ["payloadHash não-SHA256", { payloadHash: "abc" }],
    ["payloadHash maiúsculo", { payloadHash: HASH.toUpperCase() }],
    ["receivedAt", { receivedAt: new Date("x") }],
  ])("rejeita %s inválido", (_n, change) => {
    expect(() =>
      InboxMessage.receive({
        messageId: "m",
        consumerName: "c",
        payloadHash: HASH,
        receivedAt: at(1),
        ...change,
      }),
    ).toThrow(InvalidArgumentError);
  });

  test("rehydrate preserva o estado, inclusive processada, e continua imutável", () => {
    const m = InboxMessage.rehydrate({
      messageId: "m",
      consumerName: "c",
      payloadHash: "nao-valida",
      receivedAt: at(1),
      processedAt: at(2),
    });
    expect(m.isProcessed()).toBe(true);
    expect(() => m.markProcessed(at(3))).toThrow(InvalidMessageStateError);
  });
});

describe("OutboxMessage", () => {
  // um único evento por teste: chamar de novo geraria outra transação, com outros ids
  const source = WagerTransactionProcessed.from(
    makeProcessed(),
    eventContext({ eventId: "evt-A" }),
  );
  const event = () => source;
  const enqueue = () => OutboxMessage.enqueue(source, "wallet-1");

  test("enqueue usa o eventId como id e serializa o envelope inteiro", () => {
    const m = enqueue();
    expect(m.id).toBe("evt-A");
    expect(m.eventType).toBe("WagerTransactionProcessed");
    expect(m.messageGroupId).toBe("wallet-1");
    expect(m.aggregateId).toBe(event().aggregateId);
    expect(m.payload).toEqual(JSON.parse(JSON.stringify(event().toJSON())));
    expect(m.attempts).toBe(0);
    expect(m.isPending()).toBe(true);
    expect(m.lastError).toBeUndefined();
  });

  test("o payload é imutável", () => {
    const m = enqueue();
    expect(Object.isFrozen(m.payload)).toBe(true);
    expect(() => {
      (m.payload as { eventId: string }).eventId = "x";
    }).toThrow();
  });

  test("nasce vencida no instante do evento (limite inclusivo)", () => {
    const m = enqueue();
    expect(m.isDue(at(10))).toBe(true);
    expect(m.isDue(new Date(at(10).getTime() - 1))).toBe(false);
    expect(m.isDue(at(11))).toBe(true);
  });

  test("exige messageGroupId", () => {
    expect(() => OutboxMessage.enqueue(event(), " ")).toThrow(InvalidArgumentError);
  });

  test("markPublished retira da fila e não pode repetir nem reagendar", () => {
    const m = enqueue();
    m.markPublished(at(12));
    expect(m.isPending()).toBe(false);
    expect(m.isDue(at(9999))).toBe(false);
    expect(m.publishedAt?.toISOString()).toBe(at(12).toISOString());
    expect(() => m.markPublished(at(13))).toThrow(InvalidMessageStateError);
    expect(() => m.scheduleRetry(at(13))).toThrow(InvalidMessageStateError);
  });

  test("markPublished limpa o último erro", () => {
    const m = enqueue();
    m.scheduleRetry(at(11), { reason: "sqs down" });
    m.markPublished(at(20));
    expect(m.lastError).toBeUndefined();
  });

  test("scheduleRetry soma tentativas e aplica backoff exponencial a partir de 'now'", () => {
    const m = enqueue();
    const now = at(100);
    const expected = [1_000, 2_000, 4_000, 8_000];
    expected.forEach((delay, i) => {
      m.scheduleRetry(now);
      expect(m.attempts).toBe(i + 1);
      expect(m.nextAttemptAt.getTime()).toBe(now.getTime() + delay);
    });
  });

  test("a mensagem em espera não está vencida até nextAttemptAt", () => {
    const m = enqueue();
    m.scheduleRetry(at(100));
    expect(m.isDue(at(100))).toBe(false);
    expect(m.isDue(new Date(at(100).getTime() + 999))).toBe(false);
    expect(m.isDue(new Date(at(100).getTime() + 1_000))).toBe(true);
  });

  test("o backoff respeita o teto e o jitter injetado", () => {
    const m = enqueue();
    for (let i = 0; i < 30; i++) m.scheduleRetry(at(0));
    expect(m.nextAttemptAt.getTime()).toBe(at(0).getTime() + OUTBOX_BACKOFF.capMs);
    const j = enqueue();
    j.scheduleRetry(at(0), { jitter: 1.5 });
    expect(j.nextAttemptAt.getTime()).toBe(at(0).getTime() + 1_500);
  });

  test("guarda o motivo, truncado em 500 caracteres", () => {
    const m = enqueue();
    m.scheduleRetry(at(1), { reason: "x".repeat(900) });
    expect(m.lastError?.length).toBe(500);
    m.scheduleRetry(at(2));
    expect(m.lastError?.length).toBe(500); // sem motivo novo, preserva o anterior
  });

  test("datas inválidas não alteram o estado", () => {
    const m = enqueue();
    expect(() => m.scheduleRetry(new Date("x"))).toThrow(InvalidArgumentError);
    expect(m.attempts).toBe(0);
    expect(() => m.markPublished(new Date("x"))).toThrow(InvalidArgumentError);
    expect(m.isPending()).toBe(true);
  });

  test("getters de data devolvem cópias", () => {
    const m = enqueue();
    m.nextAttemptAt.setFullYear(1999);
    m.occurredAt.setFullYear(1999);
    expect(m.nextAttemptAt.toISOString()).toBe(at(10).toISOString());
    expect(m.occurredAt.toISOString()).toBe(at(10).toISOString());
  });

  test("rehydrate preserva tentativas, publicação e erro", () => {
    const m = OutboxMessage.rehydrate({
      id: "e",
      aggregateId: "a",
      messageGroupId: "g",
      eventType: "T",
      payload: { k: 1 },
      occurredAt: at(1),
      attempts: 3,
      nextAttemptAt: at(50),
      publishedAt: undefined,
      lastError: "boom",
    });
    expect(m.attempts).toBe(3);
    expect(m.lastError).toBe("boom");
    m.scheduleRetry(at(60));
    expect(m.attempts).toBe(4);
    expect(m.nextAttemptAt.getTime()).toBe(at(60).getTime() + 8_000);
  });
});
