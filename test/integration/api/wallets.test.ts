import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { v7 } from "uuid";
import { MikroOrmUnitOfWork } from "../../../src/shared/infrastructure/persistence/mikro-orm-unit-of-work";
import { WagerTransactionKind as Kind } from "../../../src/wagering/domain";
import { MikroOrmWagerTransactionRepository } from "../../../src/wagering/infrastructure/persistence/wager-transaction.repository";
import type { LedgerRepository } from "../../../src/wallet/application/ports/wallet-repositories";
import { ReconcileWalletUseCase } from "../../../src/wallet/application/reconcile-wallet.use-case";
import { MikroOrmLedgerRepository } from "../../../src/wallet/infrastructure/persistence/ledger.repository";
import { MikroOrmWalletRepository } from "../../../src/wallet/infrastructure/persistence/wallet.repository";
import { createTestDatabase, expectInvariants, type TestDatabase } from "../../support/database";
import { startApi, type TestApi } from "../../support/http-app";
import { brl } from "../../support/money";
import { applyInDb, newTx } from "../../support/persisted-flow";

let db: TestDatabase;
let api: TestApi;

beforeAll(async () => {
  db = await createTestDatabase({ poolMax: 30 });
  api = await startApi(db);
});

afterAll(async () => {
  await api?.close();
  await db?.close();
});

const money = (amount: string, currency = "BRL") => ({ amount, currency });
const createBody = (overrides: Record<string, unknown> = {}) => ({
  playerId: v7(),
  initialBalance: money("1000.00"),
  ...overrides,
});

async function createWallet(overrides: Record<string, unknown> = {}) {
  const res = await api.request("POST", "/wallets", { body: createBody(overrides) });
  expect(res.status).toBe(201);
  return res.body as {
    id: string;
    playerId: string;
    balance: { amount: string; currency: string };
    version: number;
  };
}

async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
  const rows = await db.sql<{ n: string }[]>(
    `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
    params,
  );
  return Number(rows[0]?.n);
}

describe("POST /wallets", () => {
  test("cria wallet, transação OPENING, lançamento e eventos na mesma transação SQL", async () => {
    const playerId = v7();
    const res = await api.request("POST", "/wallets", {
      body: createBody({ playerId }),
      headers: { "x-correlation-id": "corr-create-1" },
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      playerId,
      balance: { amount: "1000.00", currency: "BRL" },
      version: 1,
    });
    expect(res.headers.get("location")).toBe(`/wallets/${res.body.id}`);
    expect(res.headers.get("x-correlation-id")).toBe("corr-create-1");

    const id = res.body.id as string;
    const [wallet] = await db.sql<{ balance: string; version: number }[]>(
      `SELECT balance, version FROM wallets WHERE id = ?`,
      [id],
    );
    expect(wallet).toEqual({ balance: "1000.00", version: 1 });

    const [opening] = await db.sql<Record<string, unknown>[]>(
      `SELECT kind, status, amount, observed_balance, provider_id FROM wager_transactions WHERE wallet_id = ?`,
      [id],
    );
    expect(opening).toMatchObject({
      kind: "OPENING",
      status: "PROCESSED",
      amount: "1000.00",
      observed_balance: "1000.00",
    });

    const [entry] = await db.sql<Record<string, unknown>[]>(
      `SELECT direction, amount, balance_before, balance_after FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [id],
    );
    expect(entry).toEqual({
      direction: "CREDIT",
      amount: "1000.00",
      balance_before: "0.00",
      balance_after: "1000.00",
    });

    const events = await db.sql<{ event_type: string; message_group_id: string; payload: any }[]>(
      `SELECT event_type, message_group_id, payload FROM outbox_messages WHERE message_group_id = ? ORDER BY event_type`,
      [id],
    );
    expect(events.map((e) => e.event_type)).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    for (const event of events) {
      expect(event.message_group_id).toBe(id);
      expect(event.payload.correlationId).toBe("corr-create-1");
    }
    await expectInvariants(db);
  });

  test("saldo inicial zero cria só a wallet: sem OPENING, lançamento nem evento", async () => {
    const wallet = await createWallet({ initialBalance: money("0.00") });
    expect(wallet.balance.amount).toBe("0.00");
    expect(await count("wager_transactions", "wallet_id = ?", [wallet.id])).toBe(0);
    expect(await count("wallet_ledger_entries", "wallet_id = ?", [wallet.id])).toBe(0);
    expect(await count("outbox_messages", "aggregate_id = ?", [wallet.id])).toBe(0);
    await expectInvariants(db);
  });

  test("wallet duplicada (playerId + moeda) é 409 e não grava nada", async () => {
    const playerId = v7();
    await createWallet({ playerId });
    const before = {
      wallets: await count("wallets"),
      ledger: await count("wallet_ledger_entries"),
      outbox: await count("outbox_messages"),
    };

    const res = await api.request("POST", "/wallets", { body: createBody({ playerId }) });

    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.body).toMatchObject({ status: 409, code: "WALLET_ALREADY_EXISTS" });
    expect({
      wallets: await count("wallets"),
      ledger: await count("wallet_ledger_entries"),
      outbox: await count("outbox_messages"),
    }).toEqual(before);
    await expectInvariants(db);
  });

  test("o mesmo jogador pode ter uma wallet por moeda", async () => {
    const playerId = v7();
    await createWallet({ playerId, initialBalance: money("5.00", "BRL") });
    const usd = await createWallet({ playerId, initialBalance: money("7.00", "USD") });
    expect(usd.balance).toEqual({ amount: "7.00", currency: "USD" });
    expect(await count("wallets", "player_id = ?", [playerId])).toBe(2);
  });

  test("criação concorrente da mesma wallet: uma vence, as outras 19 recebem 409", async () => {
    const playerId = v7();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        api.request("POST", "/wallets", {
          body: createBody({ playerId, initialBalance: money("50.00") }),
        }),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(19);
    for (const r of results.filter((x) => x.status === 409)) {
      expect(r.body.code).toBe("WALLET_ALREADY_EXISTS");
    }
    expect(await count("wallets", "player_id = ?", [playerId])).toBe(1);
    const winner = results.find((r) => r.status === 201)?.body.id as string;
    expect(await count("wallet_ledger_entries", "wallet_id = ?", [winner])).toBe(1);
    expect(await count("wager_transactions", "wallet_id = ?", [winner])).toBe(1);
    expect(await count("outbox_messages", "message_group_id = ?", [winner])).toBe(2);
    await expectInvariants(db);
  });

  const invalidBodies: [string, unknown][] = [
    ["sem playerId", { initialBalance: money("1.00") }],
    ["playerId que não é UUID", createBody({ playerId: "player-1" })],
    ["sem initialBalance", { playerId: v7() }],
    ["amount sem casas decimais", createBody({ initialBalance: money("10") })],
    ["amount com 1 casa decimal", createBody({ initialBalance: money("10.5") })],
    ["amount com 3 casas decimais", createBody({ initialBalance: money("10.123") })],
    ["amount numérico (float)", createBody({ initialBalance: { amount: 10.5, currency: "BRL" } })],
    ["amount negativo", createBody({ initialBalance: money("-1.00") })],
    ["amount em notação científica", createBody({ initialBalance: money("1e3") })],
    ["moeda em minúsculas", createBody({ initialBalance: money("1.00", "brl") })],
    ["moeda com 2 letras", createBody({ initialBalance: money("1.00", "BR") })],
    ["campo desconhecido", createBody({ id: v7() })],
    [
      "valor acima do limite numeric(19,2)",
      createBody({ initialBalance: money(`1${"0".repeat(17)}.00`) }),
    ],
    ["corpo não é objeto", []],
  ];
  for (const [label, body] of invalidBodies) {
    test(`400 INVALID_PAYLOAD: ${label}`, async () => {
      const before = await count("wallets");
      const res = await api.request("POST", "/wallets", { body });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(res.body.code).toBe("INVALID_PAYLOAD");
      expect(await count("wallets")).toBe(before);
    });
  }

  test("400 INVALID_PAYLOAD com errors[] apontando o campo, sem ecoar o valor enviado", async () => {
    const res = await api.request("POST", "/wallets", {
      body: createBody({ playerId: "segredo-123" }),
    });
    expect(res.body.errors).toEqual([{ path: "playerId", message: expect.any(String) }]);
    expect(JSON.stringify(res.body)).not.toContain("segredo-123");
  });

  test("JSON malformado é 400 INVALID_PAYLOAD e sem corpo também", async () => {
    const malformed = await api.request("POST", "/wallets", { rawBody: "{not json" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe("INVALID_PAYLOAD");
    expect(malformed.headers.get("content-type")).toContain("application/problem+json");

    const empty = await api.request("POST", "/wallets");
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("INVALID_PAYLOAD");
  });

  test("corpo grande demais é 413 PAYLOAD_TOO_LARGE", async () => {
    const res = await api.request("POST", "/wallets", {
      rawBody: JSON.stringify({ playerId: v7(), pad: "x".repeat(200_000) }),
    });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("GET /wallets/:walletId", () => {
  test("devolve o estado atual da wallet", async () => {
    const created = await createWallet({ initialBalance: money("12.34") });
    const res = await api.request("GET", `/wallets/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: created.id,
      playerId: created.playerId,
      balance: { amount: "12.34", currency: "BRL" },
      version: 1,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
  });

  test("reflete saldo e versão depois de movimentações", async () => {
    const created = await createWallet({ initialBalance: money("100.00") });
    const wallet = await db.wallets.findById(created.id);
    if (!wallet) throw new Error("wallet sumiu");
    await applyInDb(db, newTx(db, wallet, { money: brl("30.00") }));

    const res = await api.request("GET", `/wallets/${created.id}`);
    expect(res.body.balance).toEqual({ amount: "70.00", currency: "BRL" });
    expect(res.body.version).toBe(2);
  });

  test("404 WALLET_NOT_FOUND para wallet inexistente", async () => {
    const res = await api.request("GET", `/wallets/${v7()}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.body).toMatchObject({ status: 404, code: "WALLET_NOT_FOUND" });
  });

  test("400 quando o id não é UUID (nunca chega ao banco)", async () => {
    const res = await api.request("GET", "/wallets/abc");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PAYLOAD");
  });
});

describe("GET /wallets/:walletId/ledger", () => {
  /** Wallet com 1 lançamento de abertura + `n` apostas de 1,00. */
  async function walletWithEntries(n: number) {
    const created = await createWallet({ initialBalance: money(`${n + 10}.00`) });
    const wallet = await db.wallets.findById(created.id);
    if (!wallet) throw new Error("wallet sumiu");
    for (let i = 0; i < n; i++) await applyInDb(db, newTx(db, wallet, { money: brl("1.00") }));
    return created;
  }

  async function readAll(walletId: string, limit: number) {
    const pages: any[] = [];
    let cursor: string | null = null;
    do {
      const path: string = `/wallets/${walletId}/ledger?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await api.request("GET", path);
      expect(res.status).toBe(200);
      pages.push(res.body);
      cursor = res.body.nextCursor;
    } while (cursor);
    return pages;
  }

  test("pagina do mais novo ao mais antigo, sem pular nem repetir", async () => {
    const wallet = await walletWithEntries(24);
    const pages = await readAll(wallet.id, 7);

    expect(pages.map((p) => p.items.length)).toEqual([7, 7, 7, 4]);
    expect(pages.at(-1).nextCursor).toBeNull();
    const ids = pages.flatMap((p) => p.items.map((i: { id: string }) => i.id));
    expect(new Set(ids).size).toBe(25);

    const expected = await db.sql<{ id: string }[]>(
      `SELECT id FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY seq DESC`,
      [wallet.id],
    );
    expect(ids).toEqual(expected.map((r) => r.id));
  });

  test("cada item traz direção, valor e saldos antes/depois", async () => {
    const wallet = await walletWithEntries(1);
    const res = await api.request("GET", `/wallets/${wallet.id}/ledger`);
    expect(res.body.items).toEqual([
      {
        id: expect.any(String),
        transactionId: expect.any(String),
        direction: "DEBIT",
        amount: { amount: "1.00", currency: "BRL" },
        balanceBefore: { amount: "11.00", currency: "BRL" },
        balanceAfter: { amount: "10.00", currency: "BRL" },
        createdAt: expect.any(String),
      },
      expect.objectContaining({ direction: "CREDIT" }),
    ]);
    expect(res.body.nextCursor).toBeNull();
  });

  test("o cursor é estável: lançamentos novos não deslocam as páginas já lidas", async () => {
    const wallet = await walletWithEntries(9);
    const first = await api.request("GET", `/wallets/${wallet.id}/ledger?limit=4`);
    const row = await db.wallets.findById(wallet.id);
    if (!row) throw new Error("wallet sumiu");
    // Chegam 3 apostas novas entre a leitura da 1ª e da 2ª página.
    for (let i = 0; i < 3; i++) await applyInDb(db, newTx(db, row, { money: brl("1.00") }));

    const second = await api.request(
      "GET",
      `/wallets/${wallet.id}/ledger?limit=100&cursor=${first.body.nextCursor}`,
    );
    const seen = [...first.body.items, ...second.body.items].map((i: { id: string }) => i.id);
    expect(new Set(seen).size).toBe(seen.length);
    // As 4 primeiras (pré-chegada) + as 6 restantes, exatamente as 10 originais.
    expect(seen).toHaveLength(10);
  });

  test("wallet sem lançamentos devolve página vazia", async () => {
    const wallet = await createWallet({ initialBalance: money("0.00") });
    const res = await api.request("GET", `/wallets/${wallet.id}/ledger`);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  test("limit padrão é 50 e o máximo é 200", async () => {
    const wallet = await walletWithEntries(55);
    const def = await api.request("GET", `/wallets/${wallet.id}/ledger`);
    expect(def.body.items).toHaveLength(50);
    expect(def.body.nextCursor).not.toBeNull();
    const max = await api.request("GET", `/wallets/${wallet.id}/ledger?limit=200`);
    expect(max.body.items).toHaveLength(56);
  });

  for (const limit of ["0", "201", "-1", "abc", "1.5", "", "99999"]) {
    test(`400 para limit=${JSON.stringify(limit)}`, async () => {
      const wallet = await createWallet({ initialBalance: money("0.00") });
      const res = await api.request("GET", `/wallets/${wallet.id}/ledger?limit=${limit}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_PAYLOAD");
    });
  }

  test("400 INVALID_CURSOR para cursor adulterado, de outra wallet ou sem sentido", async () => {
    const a = await walletWithEntries(5);
    const b = await walletWithEntries(5);
    const cursorOfA = (await api.request("GET", `/wallets/${a.id}/ledger?limit=2`)).body
      .nextCursor as string;

    const forged = Buffer.from(
      JSON.stringify({ v: 1, w: a.id, s: "1; DROP TABLE wallets" }),
    ).toString("base64url");
    for (const cursor of [
      "lixo",
      cursorOfA.slice(0, -3),
      forged,
      Buffer.from("[]").toString("base64url"),
    ]) {
      const res = await api.request("GET", `/wallets/${a.id}/ledger?cursor=${cursor}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_CURSOR");
    }
    const crossed = await api.request("GET", `/wallets/${b.id}/ledger?cursor=${cursorOfA}`);
    expect(crossed.status).toBe(400);
    expect(crossed.body.code).toBe("INVALID_CURSOR");
  });

  test("404 para wallet inexistente", async () => {
    const res = await api.request("GET", `/wallets/${v7()}/ledger`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("WALLET_NOT_FOUND");
  });
});

describe("POST /wallets/:walletId/reconciliation", () => {
  test("wallet íntegra: consistente, diferença zero e contagem de lançamentos", async () => {
    const created = await createWallet({ initialBalance: money("100.00") });
    const wallet = await db.wallets.findById(created.id);
    if (!wallet) throw new Error("wallet sumiu");
    const bet = newTx(db, wallet, { money: brl("25.00") });
    await applyInDb(db, bet);
    await applyInDb(
      db,
      newTx(db, wallet, {
        kind: Kind.Win,
        money: brl("10.00"),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    const res = await api.request("POST", `/wallets/${created.id}/reconciliation`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: created.id,
      storedBalance: { amount: "85.00", currency: "BRL" },
      calculatedBalance: { amount: "85.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 3,
    });
    await expectInvariants(db);
  });

  test("wallet sem lançamentos e saldo zero é consistente com 0 lançamentos", async () => {
    const created = await createWallet({ initialBalance: money("0.00") });
    const res = await api.request("POST", `/wallets/${created.id}/reconciliation`);
    expect(res.body).toMatchObject({
      consistent: true,
      checkedEntries: 0,
      calculatedBalance: { amount: "0.00" },
    });
  });

  test("divergência provocada: sinalizada na resposta, logada na métrica e NÃO corrigida", async () => {
    const created = await createWallet({ initialBalance: money("100.00") });
    const metricBefore = await divergenceCount();
    // Corrompe de propósito, como um bug ou operador faria: desliga os triggers e mexe no saldo.
    await db.sql(`ALTER TABLE wallets DISABLE TRIGGER USER`);
    try {
      await db.sql(`UPDATE wallets SET balance = 130.50 WHERE id = ?`, [created.id]);
    } finally {
      await db.sql(`ALTER TABLE wallets ENABLE TRIGGER USER`);
    }

    const res = await api.request("POST", `/wallets/${created.id}/reconciliation`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: created.id,
      storedBalance: { amount: "130.50", currency: "BRL" },
      calculatedBalance: { amount: "100.00", currency: "BRL" },
      difference: { amount: "30.50", currency: "BRL" },
      consistent: false,
      checkedEntries: 1,
    });
    expect(await divergenceCount()).toBe(metricBefore + 1);

    const [after] = await db.sql<{ balance: string; version: number }[]>(
      `SELECT balance, version FROM wallets WHERE id = ?`,
      [created.id],
    );
    expect(after).toEqual({ balance: "130.50", version: 1 }); // nada foi "consertado"

    // Repetir não corrige nem some: continua sinalizando e contando.
    const again = await api.request("POST", `/wallets/${created.id}/reconciliation`);
    expect(again.body.consistent).toBe(false);
    expect(await divergenceCount()).toBe(metricBefore + 2);

    // Restaura o banco para o checker global dos demais testes.
    await db.sql(`ALTER TABLE wallets DISABLE TRIGGER USER`);
    await db.sql(`UPDATE wallets SET balance = 100.00 WHERE id = ?`, [created.id]);
    await db.sql(`ALTER TABLE wallets ENABLE TRIGGER USER`);
    await expectInvariants(db);
  });

  test("divergência com saldo MENOR que o ledger dá diferença negativa", async () => {
    const created = await createWallet({ initialBalance: money("100.00") });
    await db.sql(`ALTER TABLE wallets DISABLE TRIGGER USER`);
    await db.sql(`UPDATE wallets SET balance = 40.00 WHERE id = ?`, [created.id]);
    await db.sql(`ALTER TABLE wallets ENABLE TRIGGER USER`);

    const res = await api.request("POST", `/wallets/${created.id}/reconciliation`);
    expect(res.body.difference).toEqual({ amount: "-60.00", currency: "BRL" });
    expect(res.body.consistent).toBe(false);

    await db.sql(`ALTER TABLE wallets DISABLE TRIGGER USER`);
    await db.sql(`UPDATE wallets SET balance = 100.00 WHERE id = ?`, [created.id]);
    await db.sql(`ALTER TABLE wallets ENABLE TRIGGER USER`);
  });

  test("wallet consistente não incrementa a métrica de divergência", async () => {
    const created = await createWallet({ initialBalance: money("10.00") });
    const before = await divergenceCount();
    await api.request("POST", `/wallets/${created.id}/reconciliation`);
    expect(await divergenceCount()).toBe(before);
  });

  test("snapshot: reconciliar durante apostas concorrentes nunca vê meia transação", async () => {
    const created = await createWallet({ initialBalance: money("500.00") });
    const wallet = await db.wallets.findById(created.id);
    if (!wallet) throw new Error("wallet sumiu");
    const before = await divergenceCount();

    const bets = Array.from({ length: 60 }, () =>
      applyInDb(db, newTx(db, wallet, { money: brl("1.00") })),
    );
    const reconciliations = Array.from({ length: 40 }, () =>
      api.request("POST", `/wallets/${created.id}/reconciliation`),
    );
    const results = await Promise.all([Promise.all(bets), Promise.all(reconciliations)]);

    for (const r of results[1]) {
      expect(r.status).toBe(200);
      expect(r.body.consistent).toBe(true);
    }
    expect(await divergenceCount()).toBe(before);
    await expectInvariants(db);
  });

  test("snapshot determinístico: commit alheio entre a leitura do saldo e a soma do ledger não vira falsa divergência", async () => {
    const created = await createWallet({ initialBalance: money("100.00") });
    const wallet = await db.wallets.findById(created.id);
    if (!wallet) throw new Error("wallet sumiu");

    // Outro Unit of Work (outra conexão): o commit dele NÃO entra na transação da reconciliação.
    const otherUow = new MikroOrmUnitOfWork(db.orm);
    const other: TestDatabase = {
      ...db,
      uow: otherUow,
      wallets: new MikroOrmWalletRepository(otherUow),
      ledger: new MikroOrmLedgerRepository(otherUow),
      transactions: new MikroOrmWagerTransactionRepository(otherUow),
    };
    let divergences = 0;
    const racingLedger = Object.assign(Object.create(db.ledger), {
      // Entre findById(wallet) e esta soma, uma aposta de 10,00 é confirmada.
      summarize: async (walletId: string, currency: string) => {
        await applyInDb(other, newTx(other, wallet, { money: brl("10.00") }));
        return db.ledger.summarize(walletId, currency);
      },
    }) as LedgerRepository;
    const useCase = new ReconcileWalletUseCase(db.uow, db.wallets, racingLedger, {
      divergenceDetected: () => {
        divergences++;
      },
    });

    const result = await useCase.execute(created.id, "corr-snapshot");

    expect(result.consistent).toBe(true);
    expect(result.storedBalance.toString()).toBe("100.00 BRL");
    expect(result.calculatedBalance.toString()).toBe("100.00 BRL");
    expect(result.checkedEntries).toBe(1);
    expect(divergences).toBe(0);

    // A aposta de fato foi confirmada: uma nova reconciliação vê o saldo novo, também consistente.
    const after = await api.request("POST", `/wallets/${created.id}/reconciliation`);
    expect(after.body.storedBalance.amount).toBe("90.00");
    expect(after.body).toMatchObject({ consistent: true, checkedEntries: 2 });
  });

  test("404 para wallet inexistente e 400 para id inválido", async () => {
    const missing = await api.request("POST", `/wallets/${v7()}/reconciliation`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("WALLET_NOT_FOUND");
    const invalid = await api.request("POST", "/wallets/xyz/reconciliation");
    expect(invalid.status).toBe(400);
  });

  async function divergenceCount(): Promise<number> {
    const metric = await api.metrics.reconciliationDivergences.get();
    return metric.values[0]?.value ?? 0;
  }
});

describe("comportamento transversal da API", () => {
  test("rota inexistente é 404 problem+json", async () => {
    const res = await api.request("GET", "/nao-existe");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.body).toMatchObject({ status: 404, code: "NOT_FOUND", instance: "/nao-existe" });
  });

  test("todo erro leva correlationId, igual ao header da resposta", async () => {
    const res = await api.request("GET", `/wallets/${v7()}`, {
      headers: { "x-correlation-id": "abc-123" },
    });
    expect(res.body.correlationId).toBe("abc-123");
    expect(res.headers.get("x-correlation-id")).toBe("abc-123");
  });

  test("correlation id inseguro é descartado e substituído por um gerado", async () => {
    const res = await api.request("GET", `/wallets/${v7()}`, {
      headers: { "x-correlation-id": "has space and ; chars" },
    });
    expect(res.body.correlationId).not.toContain(" ");
    expect(res.body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("sem x-correlation-id, a API gera um", async () => {
    const res = await api.request("GET", `/wallets/${v7()}`);
    expect(res.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("health é público e responde sem cabeçalhos de autenticação", async () => {
    const res = await api.request("GET", "/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  test("ao final, saldo == Σ ledger em todo o banco", async () => {
    await expectInvariants(db);
  });
});
