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

describe("POST /wagering/transactions: transações processadas", () => {
  test("BET debita, devolve 200 com o saldo e grava ledger + eventos", async () => {
    const wallet = await w.createWallet("1000.00");
    const { body, res } = await w.send(wallet, { money: money("25.00") });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
      idempotentReplay: false,
    });
    expect(await w.balanceOf(wallet.id)).toBe("975.00");

    const [entry] = await db.sql<Record<string, unknown>[]>(
      "SELECT direction, amount, balance_before, balance_after FROM wallet_ledger_entries WHERE transaction_id = ?",
      [res.body.transactionId],
    );
    expect(entry).toEqual({
      direction: "DEBIT",
      amount: "25.00",
      balance_before: "1000.00",
      balance_after: "975.00",
    });
    expect(await w.eventTypes(res.body.transactionId)).toEqual(["WagerTransactionProcessed"]);
    expect(await w.eventTypes(wallet.id)).toContain("WalletBalanceChanged");

    const row = await w.row(res.body.transactionId);
    expect(row).toMatchObject({ status: "PROCESSED", observed_balance: "975.00" });
    expect(row.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.kind).toBe("BET");
  });

  test("WIN credita; LOSS não move saldo, não gera ledger nem WalletBalanceChanged", async () => {
    const wallet = await w.createWallet("100.00");
    const bet = await w.send(wallet, { money: money("30.00"), externalTransactionId: "b1" });
    const eventsBefore = (await w.eventTypes(wallet.id)).length;

    const win = await w.send(wallet, {
      kind: "WIN",
      money: money("50.00"),
      referenceExternalTransactionId: "b1",
    });
    expect(win.res.status).toBe(200);
    expect(win.res.body.balance).toEqual(money("120.00"));
    expect(await w.eventTypes(wallet.id)).toHaveLength(eventsBefore + 1);

    const ledgerBefore = await w.ledgerCount(wallet.id);
    const loss = await w.send(wallet, {
      kind: "LOSS",
      money: money("0.00"),
      referenceExternalTransactionId: "b1",
    });
    expect(loss.res.status).toBe(200);
    expect(loss.res.body.balance).toEqual(money("120.00"));
    expect(await w.ledgerCount(wallet.id)).toBe(ledgerBefore);
    expect(await w.eventTypes(loss.res.body.transactionId)).toEqual(["WagerTransactionProcessed"]);
    expect(await w.eventTypes(wallet.id)).toHaveLength(eventsBefore + 1); // sem novo BalanceChanged
    expect(bet.res.status).toBe(200);
  });

  test("REFUND de BET credita e aponta para a transação original", async () => {
    const wallet = await w.createWallet("100.00");
    const bet = await w.send(wallet, { money: money("40.00"), externalTransactionId: "b1" });
    const refund = await w.send(wallet, {
      kind: "REFUND",
      money: money("40.00"),
      referenceExternalTransactionId: "b1",
    });

    expect(refund.res.status).toBe(200);
    expect(refund.res.body.balance).toEqual(money("100.00"));
    const row = await w.row(refund.res.body.transactionId);
    expect(row.reference_transaction_id).toBe(bet.res.body.transactionId);
  });

  test("ROLLBACK desfaz no sentido inverso: de BET credita, de WIN debita, de REFUND debita", async () => {
    const wallet = await w.createWallet("200.00");
    await w.send(wallet, { money: money("50.00"), externalTransactionId: "bet" }); // 150
    await w.send(wallet, {
      kind: "WIN",
      money: money("30.00"),
      externalTransactionId: "win",
      referenceExternalTransactionId: "bet",
    }); // 180
    const rollbackWin = await w.send(wallet, {
      kind: "ROLLBACK",
      money: money("30.00"),
      referenceExternalTransactionId: "win",
    });
    expect(rollbackWin.res.body.balance).toEqual(money("150.00"));

    const bet2 = await w.send(wallet, { money: money("10.00"), externalTransactionId: "bet2" }); // 140
    await w.send(wallet, {
      kind: "REFUND",
      money: money("10.00"),
      externalTransactionId: "refund2",
      referenceExternalTransactionId: "bet2",
    }); // 150
    const rollbackRefund = await w.send(wallet, {
      kind: "ROLLBACK",
      money: money("10.00"),
      referenceExternalTransactionId: "refund2",
    });
    expect(rollbackRefund.res.body.balance).toEqual(money("140.00"));
    expect(bet2.res.status).toBe(200);

    const rollbackBet = await w.send(wallet, {
      kind: "ROLLBACK",
      money: money("50.00"),
      referenceExternalTransactionId: "bet",
    });
    expect(rollbackBet.res.body.balance).toEqual(money("190.00"));
  });
});

describe("POST /wagering/transactions: rejeições de negócio (422)", () => {
  async function expectRejected(
    result: Awaited<ReturnType<WageringApi["send"]>>,
    wallet: { id: string },
    code: string,
    action: string,
    balanceBefore: string,
  ) {
    expect(result.res.status).toBe(422);
    expect(result.res.body).toMatchObject({
      status: "REJECTED",
      failureCode: code,
      providerAction: action,
      idempotentReplay: false,
      balance: money(balanceBefore),
    });
    expect(await w.balanceOf(wallet.id)).toBe(balanceBefore);
    const id = result.res.body.transactionId;
    expect(await w.count("wallet_ledger_entries", "transaction_id = ?", [id])).toBe(0);
    expect(await w.eventTypes(id)).toEqual(["WagerTransactionRejected"]);
    expect(await w.row(id)).toMatchObject({ status: "REJECTED", failure_code: code });
  }

  test("INSUFFICIENT_FUNDS: aposta maior que o saldo", async () => {
    const wallet = await w.createWallet("10.00");
    const result = await w.send(wallet, { money: money("10.01") });
    await expectRejected(
      result,
      wallet,
      "INSUFFICIENT_FUNDS",
      "RESEND_AS_NEW_TRANSACTION",
      "10.00",
    );
  });

  test("aposta exatamente igual ao saldo é aceita e zera a wallet", async () => {
    const wallet = await w.createWallet("10.00");
    const result = await w.send(wallet, { money: money("10.00") });
    expect(result.res.status).toBe(200);
    expect(await w.balanceOf(wallet.id)).toBe("0.00");
  });

  test("CURRENCY_MISMATCH: moeda diferente da wallet", async () => {
    const wallet = await w.createWallet("100.00", "BRL");
    const result = await w.send(wallet, { money: money("5.00", "USD") });

    // O saldo da wallet está em BRL e a transação é USD: não há saldo "dela" para reportar.
    expect(result.res.status).toBe(422);
    expect(result.res.body).toMatchObject({
      status: "REJECTED",
      failureCode: "CURRENCY_MISMATCH",
      providerAction: "FIX_PAYLOAD",
      balance: null,
    });
    expect(await w.balanceOf(wallet.id)).toBe("100.00");
    expect(
      await w.count("wallet_ledger_entries", "transaction_id = ?", [result.res.body.transactionId]),
    ).toBe(0);
    expect(await w.eventTypes(result.res.body.transactionId)).toEqual(["WagerTransactionRejected"]);

    const replay = await w.submit(result.body);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...result.res.body, idempotentReplay: true });
  });

  test("PLAYER_WALLET_MISMATCH: o jogador não é o dono da wallet", async () => {
    const wallet = await w.createWallet("100.00");
    const result = await w.send(wallet, { playerId: v7() });
    await expectRejected(result, wallet, "PLAYER_WALLET_MISMATCH", "FIX_PAYLOAD", "100.00");
  });

  test("REFERENCE_MISMATCH: referência de outra rodada", async () => {
    const wallet = await w.createWallet("100.00");
    await w.send(wallet, { externalTransactionId: "b1", roundId: "round-A" });
    const result = await w.send(wallet, {
      kind: "REFUND",
      roundId: "round-B",
      referenceExternalTransactionId: "b1",
    });
    await expectRejected(result, wallet, "REFERENCE_MISMATCH", "FIX_PAYLOAD", "75.00");
  });

  test("REFERENCE_KIND_NOT_ALLOWED: REFUND de WIN", async () => {
    const wallet = await w.createWallet("100.00");
    await w.send(wallet, { externalTransactionId: "b1" });
    await w.send(wallet, {
      kind: "WIN",
      externalTransactionId: "w1",
      referenceExternalTransactionId: "b1",
    });
    const result = await w.send(wallet, {
      kind: "REFUND",
      referenceExternalTransactionId: "w1",
    });
    await expectRejected(result, wallet, "REFERENCE_KIND_NOT_ALLOWED", "FIX_PAYLOAD", "100.00");
  });

  test("REFERENCE_AMOUNT_MISMATCH: reversão com valor diferente da referência", async () => {
    const wallet = await w.createWallet("100.00");
    await w.send(wallet, { externalTransactionId: "b1", money: money("25.00") });
    const result = await w.send(wallet, {
      kind: "REFUND",
      money: money("24.99"),
      referenceExternalTransactionId: "b1",
    });
    await expectRejected(result, wallet, "REFERENCE_AMOUNT_MISMATCH", "FIX_PAYLOAD", "75.00");
  });

  test("ALREADY_REVERSED: a mesma BET não é revertida duas vezes, nem por tipos diferentes", async () => {
    const wallet = await w.createWallet("100.00");
    await w.send(wallet, { externalTransactionId: "b1" });
    const first = await w.send(wallet, { kind: "REFUND", referenceExternalTransactionId: "b1" });
    expect(first.res.status).toBe(200);

    const again = await w.send(wallet, { kind: "REFUND", referenceExternalTransactionId: "b1" });
    await expectRejected(again, wallet, "ALREADY_REVERSED", "GIVE_UP", "100.00");
    const other = await w.send(wallet, { kind: "ROLLBACK", referenceExternalTransactionId: "b1" });
    await expectRejected(other, wallet, "ALREADY_REVERSED", "GIVE_UP", "100.00");
  });

  test("REFERENCE_ALREADY_REVERSED: WIN sobre uma BET que já foi revertida", async () => {
    const wallet = await w.createWallet("100.00");
    await w.send(wallet, { externalTransactionId: "b1" });
    await w.send(wallet, { kind: "REFUND", referenceExternalTransactionId: "b1" });
    const result = await w.send(wallet, { kind: "WIN", referenceExternalTransactionId: "b1" });
    await expectRejected(result, wallet, "REFERENCE_ALREADY_REVERSED", "GIVE_UP", "100.00");
  });

  test("REVERSAL_WOULD_OVERDRAW: reversão que deixaria o saldo negativo (código distinto)", async () => {
    const wallet = await w.createWallet("100.00");
    await w.send(wallet, { externalTransactionId: "b1" }); // 75
    await w.send(wallet, {
      kind: "WIN",
      money: money("50.00"),
      externalTransactionId: "w1",
      referenceExternalTransactionId: "b1",
    }); // 125
    await w.send(wallet, { money: money("125.00"), externalTransactionId: "b2" }); // 0
    const result = await w.send(wallet, {
      kind: "ROLLBACK",
      money: money("50.00"),
      referenceExternalTransactionId: "w1",
    });
    await expectRejected(result, wallet, "REVERSAL_WOULD_OVERDRAW", "MANUAL_RESOLUTION", "0.00");
  });

  test("REFERENCE_NOT_PROCESSED: a referência foi rejeitada", async () => {
    const wallet = await w.createWallet("10.00");
    await w.send(wallet, { externalTransactionId: "b1", money: money("500.00") }); // rejeitada
    const result = await w.send(wallet, {
      kind: "REFUND",
      money: money("500.00"),
      referenceExternalTransactionId: "b1",
    });
    await expectRejected(result, wallet, "REFERENCE_NOT_PROCESSED", "GIVE_UP", "10.00");
  });
});

describe("POST /wagering/transactions: referência ausente (202)", () => {
  test("REFUND antes da BET fica PENDING_REFERENCE; a chegada da BET acorda o dependente", async () => {
    const wallet = await w.createWallet("100.00");
    const refund = await w.send(wallet, {
      kind: "REFUND",
      externalTransactionId: "refund-1",
      referenceExternalTransactionId: "bet-1",
    });

    expect(refund.res.status).toBe(202);
    expect(refund.res.body).toEqual({
      transactionId: expect.any(String),
      status: "PENDING_REFERENCE",
      balance: null,
      idempotentReplay: false,
    });
    expect(refund.res.headers.get("location")).toBe(
      `/wagering/transactions/${refund.res.body.transactionId}`,
    );
    const pending = await w.row(refund.res.body.transactionId);
    expect(pending).toMatchObject({ status: "PENDING_REFERENCE", attempts: 0 });
    expect(pending.next_attempt_at).not.toBeNull();
    expect(await w.balanceOf(wallet.id)).toBe("100.00");
    expect(await w.ledgerCount(wallet.id)).toBe(1); // só a abertura
    expect(await w.eventTypes(refund.res.body.transactionId)).toEqual([
      "WagerTransactionPendingReference",
    ]);

    await w.send(wallet, { externalTransactionId: "bet-1" }); // chega a referência

    const woken = await w.row(refund.res.body.transactionId);
    expect(woken.status).toBe("PENDING_REFERENCE"); // o reprocessamento é do M10
    expect(new Date(woken.next_attempt_at).getTime()).toBeLessThan(
      new Date(pending.next_attempt_at).getTime(),
    );
    expect(new Date(woken.next_attempt_at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  test("WIN que cita uma BET ainda inexistente também espera", async () => {
    const wallet = await w.createWallet("100.00");
    const win = await w.send(wallet, {
      kind: "WIN",
      externalTransactionId: "w1",
      referenceExternalTransactionId: "bet-x",
    });
    expect(win.res.status).toBe(202);
  });

  test("uma referência rejeitada também acorda quem a esperava", async () => {
    const wallet = await w.createWallet("10.00");
    const refund = await w.send(wallet, {
      kind: "REFUND",
      money: money("500.00"),
      referenceExternalTransactionId: "bet-big",
    });
    const before = await w.row(refund.res.body.transactionId);
    await w.send(wallet, { externalTransactionId: "bet-big", money: money("500.00") }); // rejeitada
    const after = await w.row(refund.res.body.transactionId);
    expect(new Date(after.next_attempt_at).getTime()).toBeLessThan(
      new Date(before.next_attempt_at).getTime(),
    );
  });
});

describe("GET das transações", () => {
  test("por id e por (provedor, externalTransactionId) devolvem o mesmo estado", async () => {
    const wallet = await w.createWallet("100.00");
    const { body, res } = await w.send(wallet, { externalTransactionId: "ext-get" });
    const byId = await api.request("GET", `/wagering/transactions/${res.body.transactionId}`);
    const byExt = await api.request(
      "GET",
      `/providers/provider-a/wagering/transactions/${encodeURIComponent(w.scoped(wallet, "ext-get"))}`,
    );

    expect(byId.status).toBe(200);
    expect(byExt.body).toEqual(byId.body);
    expect(byId.body).toMatchObject({
      transactionId: res.body.transactionId,
      providerId: "provider-a",
      externalTransactionId: w.scoped(wallet, "ext-get"),
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: "BET",
      money: body.money,
      status: "PROCESSED",
      failureCode: null,
      providerAction: null,
      referenceExternalTransactionId: null,
      balance: money("75.00"),
      processedAt: expect.any(String),
    });
  });

  test("uma transação REJECTED consultada é 200 (é estado, não resultado de comando)", async () => {
    const wallet = await w.createWallet("1.00");
    const { res } = await w.send(wallet, { money: money("5.00") });
    expect(res.status).toBe(422);
    const get = await api.request("GET", `/wagering/transactions/${res.body.transactionId}`);
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      providerAction: "RESEND_AS_NEW_TRANSACTION",
    });
  });

  test("PENDING_REFERENCE consultada mostra a espera", async () => {
    const wallet = await w.createWallet("1.00");
    const { res } = await w.send(wallet, {
      kind: "REFUND",
      referenceExternalTransactionId: "nobody",
    });
    const get = await api.request("GET", res.headers.get("location") as string);
    expect(get.body).toMatchObject({
      status: "PENDING_REFERENCE",
      balance: null,
      referenceExternalTransactionId: w.scoped(wallet, "nobody"),
      attempts: 0,
      nextAttemptAt: expect.any(String),
    });
  });

  test("404 TRANSACTION_NOT_FOUND nas duas consultas; 400 para id que não é UUID", async () => {
    const byId = await api.request("GET", `/wagering/transactions/${v7()}`);
    expect(byId.status).toBe(404);
    expect(byId.body.code).toBe("TRANSACTION_NOT_FOUND");
    const byExt = await api.request("GET", "/providers/provider-a/wagering/transactions/nope");
    expect(byExt.status).toBe(404);
    expect(byExt.body.code).toBe("TRANSACTION_NOT_FOUND");
    const bad = await api.request("GET", "/wagering/transactions/not-a-uuid");
    expect(bad.status).toBe(400);
  });

  test("provedores diferentes podem reutilizar o mesmo externalTransactionId", async () => {
    const wallet = await w.createWallet("100.00");
    const a = await w.send(wallet, { providerId: "provider-a", externalTransactionId: "same" });
    const b = await w.send(wallet, { providerId: "provider-b", externalTransactionId: "same" });
    expect(a.res.status).toBe(200);
    expect(b.res.status).toBe(200);
    expect(a.res.body.transactionId).not.toBe(b.res.body.transactionId);
    expect(await w.balanceOf(wallet.id)).toBe("50.00");
  });
});
