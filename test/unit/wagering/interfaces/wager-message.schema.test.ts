import { describe, expect, test } from "bun:test";
import { WagerTransactionKind } from "../../../../src/wagering/domain";
import {
  parseWagerMessage,
  WAGER_REQUESTED_TYPE,
} from "../../../../src/wagering/interfaces/sqs/wager-message.schema";

const WALLET = "0192f291-27dd-7d3f-8071-5f8685deef37";
const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";

/** O exemplo do README (RF-SQS-02). */
const readmeExample = () => ({
  messageId: "msg-123",
  type: "WagerTransactionRequested",
  occurredAt: "2026-07-29T15:00:00.000Z",
  data: {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    idempotencyKey: "provider-a:transaction-123",
    playerId: PLAYER,
    walletId: WALLET,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  },
});

const parse = (value: unknown) => parseWagerMessage(JSON.stringify(value));

describe("parseWagerMessage", () => {
  test("aceita o exemplo do README", () => {
    const parsed = parse(readmeExample());

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.message.messageId).toBe("msg-123");
      expect(parsed.message.data.kind).toBe(WagerTransactionKind.Bet);
      expect(parsed.message.data.money).toEqual({ amount: "25.00", currency: "BRL" });
    }
  });

  test("o tipo esperado é WagerTransactionRequested", () => {
    expect(WAGER_REQUESTED_TYPE).toBe("WagerTransactionRequested");
  });

  test.each(["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"])("aceita kind %s", (kind) => {
    const message = readmeExample();
    message.data.kind = kind;
    expect(parse(message).ok).toBe(true);
  });

  test("aceita referenceExternalTransactionId opcional", () => {
    const message = { ...readmeExample() };
    message.data = { ...message.data, referenceExternalTransactionId: "ref-1" } as never;
    expect(parse(message).ok).toBe(true);
  });

  test.each([
    ["corpo vazio", ""],
    ["JSON inválido", "{"],
    ["null", "null"],
    ["array", "[]"],
    ["string", '"x"'],
  ])("rejeita %s", (_label, body) => {
    expect(parseWagerMessage(body).ok).toBe(false);
  });

  test.each([
    ["messageId", (m: any) => delete m.messageId],
    ["type", (m: any) => delete m.type],
    ["occurredAt", (m: any) => delete m.occurredAt],
    ["data", (m: any) => delete m.data],
    ["data.providerId", (m: any) => delete m.data.providerId],
    ["data.externalTransactionId", (m: any) => delete m.data.externalTransactionId],
    ["data.idempotencyKey", (m: any) => delete m.data.idempotencyKey],
    ["data.playerId", (m: any) => delete m.data.playerId],
    ["data.walletId", (m: any) => delete m.data.walletId],
    ["data.roundId", (m: any) => delete m.data.roundId],
    ["data.gameId", (m: any) => delete m.data.gameId],
    ["data.kind", (m: any) => delete m.data.kind],
    ["data.money", (m: any) => delete m.data.money],
  ])("rejeita sem %s", (path, mutate) => {
    const message = readmeExample();
    mutate(message);
    const parsed = parse(message);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.detail).toContain(path);
  });

  test.each([
    ["type diferente", (m: any) => (m.type = "WagerTransactionProcessed")],
    ["messageId vazio", (m: any) => (m.messageId = "")],
    ["messageId gigante", (m: any) => (m.messageId = "x".repeat(201))],
    ["occurredAt sem formato ISO", (m: any) => (m.occurredAt = "29/07/2026")],
    ["occurredAt numérico", (m: any) => (m.occurredAt = 1785337200000)],
    ["kind OPENING (interno)", (m: any) => (m.data.kind = "OPENING")],
    ["kind em minúsculas", (m: any) => (m.data.kind = "bet")],
    ["walletId não uuid", (m: any) => (m.data.walletId = "wallet-1")],
    ["playerId não uuid", (m: any) => (m.data.playerId = "player-1")],
    ["idempotencyKey em branco", (m: any) => (m.data.idempotencyKey = "   ")],
    ["idempotencyKey > 200", (m: any) => (m.data.idempotencyKey = "k".repeat(201))],
    ["idempotencyKey não imprimível", (m: any) => (m.data.idempotencyKey = "a\nb")],
    ["providerId vazio", (m: any) => (m.data.providerId = "")],
    // Formato do valor (casas, sinal, moeda ISO) é validado pelo domínio (Money.from) no preflight.
    ["valor numérico (JSON number)", (m: any) => (m.data.money.amount = 25)],
    ["moeda com mais de 3 letras", (m: any) => (m.data.money.currency = "BRLX")],
    ["campo extra na raiz", (m: any) => (m.extra = 1)],
    ["campo extra em data", (m: any) => (m.data.extra = 1)],
    ["campo extra em money", (m: any) => (m.data.money.extra = 1)],
  ])("rejeita: %s", (_label, mutate) => {
    const message = readmeExample();
    mutate(message);

    expect(parse(message).ok).toBe(false);
  });

  test("o detalhe lista no máximo 10 problemas e nunca ecoa os valores recebidos", () => {
    const parsed = parse({
      messageId: 1,
      type: 2,
      occurredAt: 3,
      data: {
        providerId: 4,
        externalTransactionId: 5,
        idempotencyKey: 6,
        playerId: "segredo-do-jogador",
        walletId: 8,
        roundId: 9,
        gameId: 10,
        kind: 11,
        money: 12,
      },
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.detail.split("; ").length).toBeLessThanOrEqual(10);
      expect(parsed.detail).not.toContain("segredo-do-jogador");
    }
  });
});
