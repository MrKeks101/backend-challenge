import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { v7 } from "uuid";
import { createTestDatabase, expectInvariants, type TestDatabase } from "../support/database";
import { startApi, type TestApi } from "../support/http-app";
import { money, WageringApi } from "../support/wagering-api";

/**
 * Paralelismo REAL: requisições simultâneas contra a API verdadeira, que as serializa só pelo
 * PostgreSQL (unique de idempotência + lock da wallet). Nenhum mock, nenhum atraso artificial.
 */
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

const statuses = (results: { status: number }[]) =>
  results.reduce<Record<number, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

describe("RF-CON-04: cenário obrigatório", () => {
  test("saldo 100,00 e duas BET de 80,00 simultâneas: uma PROCESSED, uma REJECTED, saldo 20,00, um débito", async () => {
    const wallet = await w.createWallet("100.00");
    const [a, b] = await Promise.all([
      w.send(wallet, { money: money("80.00") }),
      w.send(wallet, { money: money("80.00") }),
    ]);

    const results = [a.res, b.res];
    expect(statuses(results)).toEqual({ 200: 1, 422: 1 });
    expect(results.find((r) => r.status === 422)?.body).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      balance: money("20.00"),
    });
    expect(results.find((r) => r.status === 200)?.body.balance).toEqual(money("20.00"));
    expect(await w.balanceOf(wallet.id)).toBe("20.00");
    expect(
      await w.count("wallet_ledger_entries", "wallet_id = ? AND direction = 'DEBIT'", [wallet.id]),
    ).toBe(1);
  });

  test("repetido 25 vezes em wallets novas, tudo ao mesmo tempo (50 requisições em paralelo)", async () => {
    const wallets = await Promise.all(Array.from({ length: 25 }, () => w.createWallet("100.00")));
    const results = await Promise.all(
      wallets.flatMap((wallet) => [
        w.send(wallet, { money: money("80.00") }),
        w.send(wallet, { money: money("80.00") }),
      ]),
    );

    expect(statuses(results.map((r) => r.res))).toEqual({ 200: 25, 422: 25 });
    for (const wallet of wallets) {
      expect(await w.balanceOf(wallet.id)).toBe("20.00");
      expect(await w.ledgerCount(wallet.id)).toBe(2); // abertura + 1 débito
    }
  });

  test("retries da aposta vencedora e da rejeitada, também em paralelo, não duplicam nada", async () => {
    const wallet = await w.createWallet("100.00");
    const winner = w.body(wallet, { money: money("80.00") });
    const loser = w.body(wallet, { money: money("80.00") });
    const sends = [winner, loser].flatMap((body) =>
      Array.from({ length: 10 }, () => w.submit(body)),
    );
    const results = await Promise.all(sends);

    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(2);
    expect(await w.balanceOf(wallet.id)).toBe("20.00");
    expect(await w.ledgerCount(wallet.id)).toBe(2);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(2);
    expect(await w.count("wager_transactions", "wallet_id = ?", [wallet.id])).toBe(3);
  });
});

describe("idempotência sob concorrência (FE-03, AR-02)", () => {
  test("a mesma aposta 50× em paralelo gera UM débito e 49 replays", async () => {
    const wallet = await w.createWallet("1000.00");
    const body = w.body(wallet, { money: money("100.00") });
    const results = await Promise.all(Array.from({ length: 50 }, () => w.submit(body)));

    expect(statuses(results)).toEqual({ 200: 50 });
    expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(results.filter((r) => r.body.idempotentReplay === true)).toHaveLength(49);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    for (const r of results) expect(r.body.balance).toEqual(money("900.00"));
    expect(await w.balanceOf(wallet.id)).toBe("900.00");
    expect(await w.ledgerCount(wallet.id)).toBe(2);
    expect(
      await w.count("outbox_messages", "aggregate_id = ?", [results[0]?.body.transactionId]),
    ).toBe(1);
  });

  test("a mesma key com payloads diferentes em paralelo: um vence, o resto é 409 (nunca dois débitos)", async () => {
    const wallet = await w.createWallet("1000.00");
    const base = w.body(wallet);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        w.submit({ ...base, money: money(`${i + 1}.00`) }, "same-key"),
      ),
    );

    expect(statuses(results)).toEqual({ 200: 1, 409: 19 });
    for (const r of results.filter((x) => x.status === 409)) {
      expect(r.body.code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    }
    expect(await w.ledgerCount(wallet.id)).toBe(2);
  });

  test("o mesmo externalTransactionId sob keys diferentes em paralelo: um vence, o resto é 409", async () => {
    const wallet = await w.createWallet("1000.00");
    const body = w.body(wallet);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => w.submit(body, `key-${i}`)),
    );

    expect(statuses(results)).toEqual({ 200: 1, 409: 19 });
    for (const r of results.filter((x) => x.status === 409)) {
      expect(r.body.code).toBe("EXTERNAL_TRANSACTION_ID_CONFLICT");
    }
    expect(await w.ledgerCount(wallet.id)).toBe(2);
  });
});

describe("saldo nunca fica negativo (FE-02, AR-07)", () => {
  test("30 apostas distintas de 10,00 contra 100,00: exatamente 10 passam e o saldo termina em 0,00", async () => {
    const wallet = await w.createWallet("100.00");
    const results = await Promise.all(
      Array.from({ length: 30 }, () => w.send(wallet, { money: money("10.00") })),
    );

    expect(statuses(results.map((r) => r.res))).toEqual({ 200: 10, 422: 20 });
    for (const { res } of results.filter((r) => r.res.status === 422)) {
      expect(res.body.failureCode).toBe("INSUFFICIENT_FUNDS");
    }
    expect(await w.balanceOf(wallet.id)).toBe("0.00");
    expect(await w.ledgerCount(wallet.id)).toBe(11);
  });

  test("apostas e vitórias misturadas na mesma wallet mantêm saldo == Σ ledger", async () => {
    const wallet = await w.createWallet("500.00");
    const bet = await w.send(wallet, { externalTransactionId: "base", money: money("100.00") });
    expect(bet.res.status).toBe(200);

    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        i % 2 === 0
          ? w.send(wallet, { money: money("7.00") })
          : w.send(wallet, {
              kind: "WIN",
              money: money("3.00"),
              referenceExternalTransactionId: "base",
            }),
      ),
    );
    // 500 − 100 − 20×7 + 20×3 = 320
    expect(await w.balanceOf(wallet.id)).toBe("320.00");
  });

  test("reversões concorrentes da mesma BET: só uma é aplicada", async () => {
    const wallet = await w.createWallet("100.00");
    await w.send(wallet, { externalTransactionId: "bet", money: money("40.00") });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        w.send(wallet, {
          kind: i % 2 === 0 ? "REFUND" : "ROLLBACK",
          money: money("40.00"),
          referenceExternalTransactionId: "bet",
        }),
      ),
    );

    expect(statuses(results.map((r) => r.res))).toEqual({ 200: 1, 422: 11 });
    for (const { res } of results.filter((r) => r.res.status === 422)) {
      expect(res.body.failureCode).toBe("ALREADY_REVERSED");
    }
    expect(await w.balanceOf(wallet.id)).toBe("100.00");
  });
});

describe("wallets distintas em paralelo (AR-06)", () => {
  test("20 wallets × 5 apostas, tudo ao mesmo tempo, sem interferência entre elas", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => w.createWallet("100.00")));
    const results = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, () => w.send(wallet, { money: money("10.00") })),
      ),
    );

    expect(statuses(results.map((r) => r.res))).toEqual({ 200: 100 });
    for (const wallet of wallets) {
      expect(await w.balanceOf(wallet.id)).toBe("50.00");
      expect(await w.ledgerCount(wallet.id)).toBe(6);
    }
  });

  test("uma wallet travada por uma transação longa não bloqueia as outras", async () => {
    const slow = await w.createWallet("100.00");
    const free = await w.createWallet("100.00");
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });

    // Segura o lock de `slow` numa transação própria até que `free` seja processada.
    const holder = db.uow.run(async () => {
      await db.wallets.findByIdForUpdate(slow.id);
      locked();
      await hold;
    });
    await isLocked;

    const started = Date.now();
    const other = await w.send(free, { money: money("10.00") });
    const elapsed = Date.now() - started;
    release();
    await holder;

    expect(other.res.status).toBe(200);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("a aposta que espera o lock termina assim que ele é liberado", async () => {
    const wallet = await w.createWallet("100.00");
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.uow.run(async () => {
      await db.wallets.findByIdForUpdate(wallet.id);
      locked();
      await hold;
    });
    await isLocked;

    const pending = w.send(wallet, { money: money("10.00") });
    const raced = await Promise.race([
      pending.then(() => "done"),
      new Promise((r) => setTimeout(() => r("waiting"), 400)),
    ]);
    expect(raced).toBe("waiting"); // está de fato bloqueada pelo lock da wallet
    release();
    await holder;
    const { res } = await pending;
    expect(res.status).toBe(200);
    expect(await w.balanceOf(wallet.id)).toBe("90.00");
  });

  test("lock_timeout estourado vira 503 com Retry-After (seguro reenviar) e nada é gravado", async () => {
    const wallet = await w.createWallet("100.00");
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.uow.run(async () => {
      await db.wallets.findByIdForUpdate(wallet.id);
      locked();
      await hold;
    });
    await isLocked;

    const body = w.body(wallet, { money: money("10.00") });
    const res = await w.submit(body); // espera 5 s (lock_timeout padrão) e desiste
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("SERVICE_UNAVAILABLE");
    expect(res.headers.get("retry-after")).toBe("1");
    release();
    await holder;

    expect(
      await w.count("wager_transactions", "external_transaction_id = ?", [
        body.externalTransactionId,
      ]),
    ).toBe(0);
    const retry = await w.submit(body); // reenviar com a mesma key é seguro
    expect(retry.status).toBe(200);
    expect(retry.body.idempotentReplay).toBe(false);
    expect(await w.balanceOf(wallet.id)).toBe("90.00");
  }, 20_000);
});

describe("cargas mistas", () => {
  test("replays, rejeições, aceites e pendências simultâneos em várias wallets mantêm as invariantes", async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => w.createWallet("200.00")));
    const work: Promise<unknown>[] = [];
    for (const wallet of wallets) {
      const repeated = w.body(wallet, { money: money("15.00") });
      for (let i = 0; i < 6; i++) work.push(w.submit(repeated));
      for (let i = 0; i < 4; i++) work.push(w.send(wallet, { money: money("999.00") }));
      for (let i = 0; i < 4; i++) work.push(w.send(wallet, { money: money("5.00") }));
      work.push(
        w.send(wallet, { kind: "REFUND", referenceExternalTransactionId: `ghost-${v7()}` }),
      );
    }
    await Promise.all(work);

    for (const wallet of wallets) {
      // 200 − 15 (uma vez) − 4×5 = 165
      expect(await w.balanceOf(wallet.id)).toBe("165.00");
    }
  });
});
