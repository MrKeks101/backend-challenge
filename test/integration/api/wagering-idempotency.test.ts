import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { v7 } from "uuid";
import { createTestDatabase, expectInvariants, type TestDatabase } from "../../support/database";
import { startApi, type TestApi } from "../../support/http-app";
import { money, WageringApi } from "../../support/wagering-api";

let db: TestDatabase;
let api: TestApi;
let w: WageringApi;

beforeAll(async () => {
  db = await createTestDatabase({ poolMax: 30 });
  api = await startApi(db);
  w = new WageringApi(api, db);
});

afterAll(async () => {
  await expectInvariants(db);
  await api?.close();
  await db?.close();
});

describe("idempotência (RF-API-08..10)", () => {
  test("repetir a mesma requisição devolve o mesmo resultado com idempotentReplay=true e não duplica o débito", async () => {
    const wallet = await w.createWallet("100.00");
    const body = w.body(wallet, { money: money("30.00") });
    const first = await w.submit(body);
    const second = await w.submit(body);
    const third = await w.submit(body);

    expect(first.status).toBe(200);
    expect(first.body.idempotentReplay).toBe(false);
    for (const replay of [second, third]) {
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    }
    expect(await w.balanceOf(wallet.id)).toBe("70.00");
    expect(await w.ledgerCount(wallet.id)).toBe(2); // abertura + um único débito
    expect(await w.count("wager_transactions", "wallet_id = ?", [wallet.id])).toBe(2);
    expect(await w.count("outbox_messages", "aggregate_id = ?", [first.body.transactionId])).toBe(
      1,
    );
  });

  test("AR-29: o replay devolve o saldo ORIGINAL, não o saldo atual", async () => {
    const wallet = await w.createWallet("100.00");
    const body = w.body(wallet, { money: money("30.00") });
    const first = await w.submit(body);
    expect(first.body.balance).toEqual(money("70.00"));

    await w.send(wallet, { money: money("20.00") }); // o saldo atual passa a ser 50.00
    const replay = await w.submit(body);

    expect(replay.body.balance).toEqual(money("70.00"));
    expect(await w.balanceOf(wallet.id)).toBe("50.00");
  });

  test("replay de uma rejeição continua 422 com o mesmo failureCode e o saldo daquele momento", async () => {
    const wallet = await w.createWallet("10.00");
    const body = w.body(wallet, { money: money("50.00") });
    const first = await w.submit(body);
    await w.send(wallet, { money: money("4.00") }); // o saldo muda depois
    const replay = await w.submit(body);

    expect(first.status).toBe(422);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual(money("10.00"));
    expect(await w.count("wager_transactions", "wallet_id = ?", [wallet.id])).toBe(3);
  });

  test("replay de PENDING_REFERENCE continua 202", async () => {
    const wallet = await w.createWallet("10.00");
    const body = w.body(wallet, { kind: "REFUND", referenceExternalTransactionId: "later" });
    const first = await w.submit(body);
    const replay = await w.submit(body);
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test("a ordem das chaves do JSON não muda o hash: ainda é replay", async () => {
    const wallet = await w.createWallet("100.00");
    const body = w.body(wallet);
    const first = await w.submit(body);
    const shuffled = Object.fromEntries(Object.entries(body).reverse());
    const replay = await w.submit(shuffled);
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
  });

  test("AR-12: mesma key com payload diferente é 409 IDEMPOTENCY_KEY_CONFLICT, nunca replay", async () => {
    const wallet = await w.createWallet("100.00");
    const body = w.body(wallet, { money: money("10.00") });
    const key = "k-conflict";
    expect((await w.submit(body, key)).status).toBe(200);

    const changes: Record<string, unknown>[] = [
      { money: money("10.01") },
      { roundId: "round-2" },
      { gameId: "other-game" },
      { kind: "WIN" },
      { externalTransactionId: "other-ext" },
    ];
    for (const change of changes) {
      const res = await w.submit({ ...body, ...change }, key);
      expect(res.status).toBe(409);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(res.body.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    }
    expect(await w.balanceOf(wallet.id)).toBe("90.00");
    expect(await w.count("wager_transactions", "wallet_id = ?", [wallet.id])).toBe(2);
  });

  test("o mesmo externalTransactionId sob OUTRA key é 409 EXTERNAL_TRANSACTION_ID_CONFLICT", async () => {
    const wallet = await w.createWallet("100.00");
    const body = w.body(wallet);
    expect((await w.submit(body, "key-1")).status).toBe(200);

    const res = await w.submit(body, "key-2");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EXTERNAL_TRANSACTION_ID_CONFLICT");
    expect(await w.balanceOf(wallet.id)).toBe("75.00");
  });

  test("keys diferentes com externalTransactionId diferente são transações independentes", async () => {
    const wallet = await w.createWallet("100.00");
    const a = await w.send(wallet);
    const b = await w.send(wallet);
    expect(a.res.body.transactionId).not.toBe(b.res.body.transactionId);
    expect(await w.balanceOf(wallet.id)).toBe("50.00");
  });

  test("a key é livre: não precisa seguir o formato recomendado", async () => {
    const wallet = await w.createWallet("100.00");
    const res = await w.submit(w.body(wallet), `qualquer-${v7()}`);
    expect(res.status).toBe(200);
  });
});

describe("validação de entrada (400): nada é persistido", () => {
  async function expectBadRequest(
    overrides: Record<string, unknown> | null,
    options: { key?: string | null; code?: string } = {},
  ) {
    const wallet = await w.createWallet("100.00");
    const before = await w.count("wager_transactions");
    const body = overrides === null ? [] : w.body(wallet, overrides);
    const res = await w.submit(body as never, options.key === undefined ? "k" : options.key);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.body.code).toBe(options.code ?? "INVALID_PAYLOAD");
    expect(await w.count("wager_transactions")).toBe(before); // nada novo além da abertura da wallet criada acima
    expect(await w.balanceOf(wallet.id)).toBe("100.00");
    return res;
  }

  test("AR-38: sem o header Idempotency-Key", async () => {
    await expectBadRequest({}, { key: null, code: "MISSING_IDEMPOTENCY_KEY" });
  });

  test("header vazio, só espaços, longo demais ou com caracteres não imprimíveis", async () => {
    await expectBadRequest({}, { key: "", code: "MISSING_IDEMPOTENCY_KEY" });
    await expectBadRequest({}, { key: "   ", code: "MISSING_IDEMPOTENCY_KEY" }); // o fetch apara os espaços
    await expectBadRequest({}, { key: "k".repeat(201) });
    await expectBadRequest({}, { key: "café" });
  });

  const cases: [string, Record<string, unknown>][] = [
    ["kind OPENING (interno)", { kind: "OPENING" }],
    ["kind inexistente", { kind: "DEPOSIT" }],
    ["kind em minúsculas", { kind: "bet" }],
    ["REFUND sem referenceExternalTransactionId", { kind: "REFUND" }],
    ["ROLLBACK sem referenceExternalTransactionId", { kind: "ROLLBACK" }],
    ["BET com referência", { referenceExternalTransactionId: "x" }],
    [
      "transação que referencia a si mesma",
      { kind: "REFUND", externalTransactionId: "a", referenceExternalTransactionId: "a" },
    ],
    ["BET com valor zero", { money: money("0.00") }],
    ["valor com 1 casa decimal", { money: money("10.5") }],
    ["valor negativo", { money: money("-5.00") }],
    ["valor numérico (float)", { money: { amount: 10.5, currency: "BRL" } }],
    ["moeda inválida", { money: money("10.00", "br") }],
    ["walletId que não é UUID", { walletId: "abc" }],
    ["playerId que não é UUID", { playerId: "abc" }],
    ["providerId vazio", { providerId: "" }],
    ["externalTransactionId gigante", { externalTransactionId: "x".repeat(201) }],
    ["roundId ausente", { roundId: undefined }],
    ["gameId ausente", { gameId: undefined }],
    ["campo desconhecido", { extra: "x" }],
    ["campo de dinheiro desconhecido", { money: { amount: "1.00", currency: "BRL", extra: 1 } }],
  ];
  for (const [label, overrides] of cases) {
    test(`INVALID_PAYLOAD: ${label}`, async () => {
      await expectBadRequest(overrides);
    });
  }

  test("corpo que não é objeto", async () => {
    await expectBadRequest(null);
  });

  test("errors[] aponta o campo problemático sem ecoar o valor enviado", async () => {
    const res = await expectBadRequest({ walletId: "segredo-xyz" });
    expect(res.body.errors).toEqual([{ path: "walletId", message: expect.any(String) }]);
    expect(JSON.stringify(res.body)).not.toContain("segredo-xyz");
  });

  test("wallet inexistente é 404 WALLET_NOT_FOUND e não grava transação", async () => {
    const ghost = { id: v7(), playerId: v7() };
    const before = await w.count("wager_transactions");
    const res = await w.submit(w.body(ghost));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("WALLET_NOT_FOUND");
    expect(await w.count("wager_transactions")).toBe(before);
  });
});

describe("mapeamento de status é consistente (AR-37, AR-43)", () => {
  test("cada situação tem um status HTTP distinto", async () => {
    const wallet = await w.createWallet("10.00");
    const ok = await w.send(wallet, { money: money("1.00") });
    const pending = await w.send(wallet, { kind: "REFUND", referenceExternalTransactionId: "zz" });
    const rejected = await w.send(wallet, { money: money("999.00") });
    const invalid = await w.submit({ ...w.body(wallet), kind: "NOPE" });
    const conflict = await w.submit(
      { ...w.body(wallet), money: money("2.00") },
      w.defaultKey(ok.body),
    );
    const missing = await w.submit(w.body({ id: v7(), playerId: v7() }));

    expect(
      [ok.res, pending.res, rejected.res, invalid, conflict, missing].map((r) => r.status),
    ).toEqual([200, 202, 422, 400, 409, 404]);
  });

  test("todo erro leva problem+json com code e correlationId; o id enviado volta no header", async () => {
    const wallet = await w.createWallet("10.00");
    const res = await api.request("POST", "/wagering/transactions", {
      body: { ...w.body(wallet), kind: "NOPE" },
      headers: { "idempotency-key": "k", "x-correlation-id": "corr-42" },
    });
    expect(res.body).toMatchObject({
      status: 400,
      code: "INVALID_PAYLOAD",
      correlationId: "corr-42",
      instance: "/wagering/transactions",
    });
    expect(res.headers.get("x-correlation-id")).toBe("corr-42");
  });

  test("o correlationId da requisição vai para o envelope dos eventos da outbox", async () => {
    const wallet = await w.createWallet("10.00");
    const res = await api.request("POST", "/wagering/transactions", {
      body: w.body(wallet, { money: money("1.00") }),
      headers: { "idempotency-key": "k-corr", "x-correlation-id": "corr-evt" },
    });
    const events = await db.sql<{ payload: any }[]>(
      "SELECT payload FROM outbox_messages WHERE aggregate_id IN (?, ?)",
      [res.body.transactionId, wallet.id],
    );
    const mine = events.filter((e) => e.payload.correlationId === "corr-evt");
    expect(mine.map((e) => e.payload.eventType).sort()).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    for (const e of mine) expect(e.payload.causationId).toBe(res.body.transactionId);
  });
});
