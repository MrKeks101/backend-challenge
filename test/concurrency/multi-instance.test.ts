import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { type Cluster, createCluster, type Node, sumSeries } from "../support/cluster";
import { sendToInput, until, wagerMessage } from "../support/consumer";
import { createTestDatabase, expectInvariants, type TestDatabase } from "../support/database";
import { drainQueue } from "../support/messaging";
import { type ApiWallet, money, type WageringApi } from "../support/wagering-api";

/**
 * M12: garantias sob condições reais. Cada teste sobe PROCESSOS `bun` separados (o mesmo
 * `src/main.ts` de produção) contra o MESMO PostgreSQL e o MESMO MiniStack, e é morto com SIGKILL
 * em pontos controlados (`test/support/node-entry.ts`). Nenhuma porta é simulada. Todo teste termina
 * com o invariant checker: wallet.balance == Σ ledger (RNF-TST-04).
 */
// Subir processos e esperar a visibilidade do SQS (30 s) leva tempo; o teto é por cenário.
setDefaultTimeout(240_000);

interface Ctx {
  db: TestDatabase;
  cluster: Cluster;
}

const ALL_WORKERS = ["consumer", "publisher", "reprocessor"];

async function scenario(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const db = await createTestDatabase({ poolMax: 10 });
  const cluster = await createCluster(db);
  try {
    try {
      await fn({ db, cluster });
      await expectInvariants(db);
    } catch (error) {
      const logs = cluster.nodes.map((node) => node.tail(25)).join("\n");
      if (error instanceof Error) error.message += `\n${logs}`;
      throw error;
    }
  } finally {
    await cluster.close();
    await db.close();
  }
}

const count = async (db: TestDatabase, from: string, where = "true", params: unknown[] = []) => {
  const rows = await db.sql<{ n: string }[]>(
    `SELECT count(*)::text AS n FROM ${from} WHERE ${where}`,
    params,
  );
  return Number(rows[0]?.n ?? 0); // allow-number: contagem pequena de linhas
};

const balanceOf = async (db: TestDatabase, walletId: string) => {
  const rows = await db.sql<{ balance: string }[]>("SELECT balance FROM wallets WHERE id = ?", [
    walletId,
  ]);
  return rows[0]?.balance ?? "?";
};

const processedBets = (db: TestDatabase) =>
  count(db, "wager_transactions", "kind = 'BET' AND status = 'PROCESSED'");
const unresolved = (db: TestDatabase) =>
  count(db, "wager_transactions", "status IN ('PENDING','PENDING_REFERENCE')");
const unpublished = (db: TestDatabase) => count(db, "outbox_messages", "published_at IS NULL");

/** Soma de uma métrica em todos os nós vivos. */
async function total(nodes: Node[], name: string, labels: Record<string, string> = {}) {
  const texts = await Promise.all(nodes.filter((n) => n.alive).map((n) => n.metricsText()));
  return texts.reduce((sum, text) => sum + sumSeries(text, name, labels), 0);
}

async function wallets(w: WageringApi, n: number, balance = "1000.00"): Promise<ApiWallet[]> {
  return Promise.all(Array.from({ length: n }, () => w.createWallet(balance)));
}

const bets = (w: WageringApi, wallet: ApiWallet, n: number, prefix: string, amount = "10.00") =>
  Array.from({ length: n }, (_, i) =>
    wagerMessage(w, wallet, { externalTransactionId: `${prefix}-${i}`, money: money(amount) }),
  );

const statusCounts = (results: { status: number }[]) =>
  results.reduce<Record<number, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

/** Todos os eventos publicados == todas as linhas da outbox (nenhum perdido). */
async function expectAllEventsPublished(ctx: Ctx) {
  const received = await drainQueue(ctx.cluster.sqs, ctx.cluster.urls.events);
  const published = new Set(received.map((e) => e.eventId));
  const rows = await ctx.db.sql<{ id: string }[]>("SELECT id FROM outbox_messages");
  expect(new Set(rows.map((r) => r.id))).toEqual(published);
}

describe("(4) ≥ 3 instâncias simultâneas", () => {
  test("HTTP + SQS em 3 processos: nada perdido, nada duplicado, logs JSON e contadores exatos", () =>
    scenario(async (ctx) => {
      const { db, cluster } = ctx;
      const nodes = [
        await cluster.start("n1", { roles: ALL_WORKERS }),
        await cluster.start("n2", { roles: ALL_WORKERS }),
        await cluster.start("n3", { roles: ALL_WORKERS }),
      ];
      const w = cluster.api(nodes[0] as Node);
      const set = await wallets(w, 6);
      const PER_KIND = 10;

      // SQS: cada mensagem enviada DUAS vezes (mesmo messageId) → a inbox deduplica.
      const messages = set.flatMap((wallet) => bets(w, wallet, PER_KIND, "sqs"));
      await Promise.all(
        [...messages, ...messages].map((m) =>
          sendToInput(cluster.sqs, cluster.urls.transactions, m),
        ),
      );
      // HTTP: cada aposta enviada DUAS vezes ao mesmo tempo, para nós diferentes.
      const http = set.flatMap((wallet) =>
        Array.from({ length: PER_KIND }, (_, i) =>
          w.body(wallet, { externalTransactionId: `http-${i}`, money: money("10.00") }),
        ),
      );
      const results = await Promise.all(
        http.flatMap((body, i) => [
          cluster.api(nodes[i % 3] as Node).submit(body),
          cluster.api(nodes[(i + 1) % 3] as Node).submit(body),
        ]),
      );
      expect(statusCounts(results)).toEqual({ 200: http.length * 2 });
      expect(results.filter((r) => r.body.idempotentReplay === true)).toHaveLength(http.length);

      const expected = set.length * PER_KIND * 2;
      await until(
        async () => (await processedBets(db)) === expected,
        60_000,
        "apostas processadas",
      );
      await until(async () => (await cluster.inputDepth()) === 0, 30_000, "fila de entrada vazia");
      await until(async () => (await unpublished(db)) === 0, 30_000, "outbox publicada");

      for (const wallet of set) {
        expect(await balanceOf(db, wallet.id)).toBe("800.00");
        expect(await w.ledgerCount(wallet.id)).toBe(1 + PER_KIND * 2);
      }
      expect(await count(db, "wager_transactions", "kind = 'BET'")).toBe(expected);

      // Contagem exata, somada nos 3 processos (cada processamento conta uma vez, após o commit).
      expect(
        await total(nodes, "wager_transactions_total", { status: "PROCESSED", kind: "BET" }),
      ).toBe(expected);
      expect(await total(nodes, "wager_duplicates_total", { source: "replay" })).toBe(http.length);
      expect(await total(nodes, "wager_duplicates_total", { source: "inbox" })).toBe(
        messages.length,
      );
      expect(await total(nodes, "wallet_lock_wait_seconds_count")).toBeGreaterThanOrEqual(expected);

      await expectAllEventsPublished(ctx);

      // RNF-OBS-01/AR-55/AR-56: todo log dos 3 processos é JSON, sem valores financeiros.
      const lines = nodes.flatMap((node) => node.logs);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(typeof parsed.level).toBe("string");
        expect(line).not.toMatch(/"(amount|balance)":"\d/);
      }
      expect(lines.some((line) => JSON.parse(line).event === "http_request")).toBe(true);
    }));

  test("a mesma aposta 50× em paralelo, espalhada pelos 3 processos, gera UM débito", () =>
    scenario(async ({ db, cluster }) => {
      const nodes = [
        await cluster.start("n1", { roles: [] }),
        await cluster.start("n2", { roles: [] }),
        await cluster.start("n3", { roles: [] }),
      ];
      const w = cluster.api(nodes[0] as Node);
      const [wallet] = await wallets(w, 1, "1000.00");
      const body = w.body(wallet as ApiWallet, { money: money("100.00") });

      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => cluster.api(nodes[i % 3] as Node).submit(body)),
      );

      expect(statusCounts(results)).toEqual({ 200: 50 });
      expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
      expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
      expect(await balanceOf(db, (wallet as ApiWallet).id)).toBe("900.00");
      expect(await w.ledgerCount((wallet as ApiWallet).id)).toBe(2);
    }));

  test("(2) disputa de saldo entre processos: 100,00 e duas BET de 80,00 → uma passa, saldo 20,00", () =>
    scenario(async ({ db, cluster }) => {
      const nodes = [
        await cluster.start("n1", { roles: [] }),
        await cluster.start("n2", { roles: [] }),
        await cluster.start("n3", { roles: [] }),
      ];
      const w = cluster.api(nodes[0] as Node);
      const set = await wallets(w, 12, "100.00");

      const results = await Promise.all(
        set.flatMap((wallet, i) => [
          cluster
            .api(nodes[i % 3] as Node)
            .submit(w.body(wallet, { externalTransactionId: "a", money: money("80.00") })),
          cluster
            .api(nodes[(i + 1) % 3] as Node)
            .submit(w.body(wallet, { externalTransactionId: "b", money: money("80.00") })),
        ]),
      );

      expect(statusCounts(results)).toEqual({ 200: 12, 422: 12 });
      for (const wallet of set) {
        expect(await balanceOf(db, wallet.id)).toBe("20.00");
        expect(await w.ledgerCount(wallet.id)).toBe(2);
      }
    }));

  test("(3) wallets distintas em paralelo nos 3 processos: cada uma com o seu saldo exato", () =>
    scenario(async ({ db, cluster }) => {
      const nodes = [
        await cluster.start("n1", { roles: [] }),
        await cluster.start("n2", { roles: [] }),
        await cluster.start("n3", { roles: [] }),
      ];
      const w = cluster.api(nodes[0] as Node);
      const set = await wallets(w, 30, "500.00");

      const results = await Promise.all(
        set.flatMap((wallet, i) =>
          Array.from({ length: 5 }, (_, k) =>
            cluster
              .api(nodes[(i + k) % 3] as Node)
              .submit(w.body(wallet, { externalTransactionId: `b${k}`, money: money("10.00") })),
          ),
        ),
      );

      expect(statusCounts(results)).toEqual({ 200: 150 });
      for (const wallet of set) expect(await balanceOf(db, wallet.id)).toBe("450.00");
    }));
});

describe("(5) worker morto entre o commit e o ack", () => {
  test("SIGKILL depois do COMMIT e antes do ack: a reentrega é absorvida pela inbox, um só débito", () =>
    scenario(async (ctx) => {
      const { db, cluster } = ctx;
      const doomed = await cluster.start("doomed", {
        roles: ["consumer"],
        crash: { point: "consumer_after_commit" },
      });
      const w = cluster.api(doomed);
      const [wallet] = (await wallets(w, 1, "100.00")) as [ApiWallet];
      await sendToInput(
        cluster.sqs,
        cluster.urls.transactions,
        wagerMessage(w, wallet, { externalTransactionId: "bet", money: money("30.00") }),
      );

      await until(() => !doomed.alive, 30_000, "consumidor morrer");
      expect(await doomed.exited).not.toBe(0); // morto à força, não por saída limpa
      // O efeito já estava commitado; a mensagem NÃO foi apagada (continua na fila, em voo).
      expect(await balanceOf(db, wallet.id)).toBe("70.00");
      expect(await count(db, "inbox_messages", "processed_at IS NOT NULL")).toBe(1);
      expect(await cluster.inputDepth()).toBe(1);

      const rescuer = await cluster.start("rescuer", { roles: ["consumer", "publisher"] });
      await until(async () => (await cluster.inputDepth()) === 0, 120_000, "reentrega consumida");

      expect(await balanceOf(db, wallet.id)).toBe("70.00");
      expect(await w.ledgerCount(wallet.id)).toBe(2);
      expect(await count(db, "wager_transactions", "wallet_id = ?", [wallet.id])).toBe(2);
      expect(await rescuer.metric("wager_duplicates_total", { source: "inbox" })).toBe(1);
      expect(await rescuer.metric("wager_transactions_total", { kind: "BET" })).toBe(0);
    }));

  test("SIGKILL imediatamente antes do COMMIT: nada fica gravado e a reentrega processa uma vez", () =>
    scenario(async (ctx) => {
      const { db, cluster } = ctx;
      const doomed = await cluster.start("doomed", {
        roles: ["consumer"],
        crash: { point: "consumer_before_commit" },
      });
      const w = cluster.api(doomed);
      const [wallet] = (await wallets(w, 1, "100.00")) as [ApiWallet];
      await sendToInput(
        cluster.sqs,
        cluster.urls.transactions,
        wagerMessage(w, wallet, { externalTransactionId: "bet", money: money("30.00") }),
      );

      await until(() => !doomed.alive, 30_000, "consumidor morrer");
      // Transação desfeita pelo PostgreSQL: nem débito, nem transação, nem linha de inbox.
      expect(await balanceOf(db, wallet.id)).toBe("100.00");
      expect(
        await count(db, "wager_transactions", "wallet_id = ? AND kind = 'BET'", [wallet.id]),
      ).toBe(0);
      expect(await count(db, "inbox_messages")).toBe(0);
      expect(await cluster.inputDepth()).toBe(1);

      const rescuer = await cluster.start("rescuer", { roles: ["consumer"] });
      await until(async () => (await cluster.inputDepth()) === 0, 120_000, "reentrega consumida");

      expect(await balanceOf(db, wallet.id)).toBe("70.00");
      expect(await w.ledgerCount(wallet.id)).toBe(2);
      expect(
        await rescuer.metric("wager_transactions_total", { status: "PROCESSED", kind: "BET" }),
      ).toBe(1);
      expect(await rescuer.metric("wager_duplicates_total", { source: "inbox" })).toBe(0);
    }));
});

describe("(6) dois publishers sobre a mesma outbox", () => {
  async function seedOutbox({ cluster }: Ctx) {
    const producer = await cluster.start("producer", { roles: [] }); // grava na outbox, não publica
    const w = cluster.api(producer);
    const set = await wallets(w, 5, "1000.00");
    for (const wallet of set) {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          w.send(wallet, { externalTransactionId: `b${i}`, money: money("10.00") }),
        ),
      );
    }
    return producer;
  }

  test("publicam juntos: nenhum evento perdido, outbox inteira marcada, e o lag aparece com o publisher parado", () =>
    scenario(async (ctx) => {
      const { db, cluster } = ctx;
      const producer = await seedOutbox(ctx);
      const rows = await count(db, "outbox_messages");
      expect(rows).toBeGreaterThan(40);

      // Sem publisher: o backlog e o lag (lidos do banco no scrape) crescem.
      expect(await producer.metric("outbox_pending_total")).toBe(rows);
      const lagBefore = await producer.metric("outbox_lag_seconds");
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(await producer.metric("outbox_lag_seconds")).toBeGreaterThan(lagBefore);
      expect(lagBefore).toBeGreaterThan(0);

      const p1 = await cluster.start("p1", {
        roles: ["publisher"],
        env: { OUTBOX_BATCH_SIZE: "7" },
      });
      const p2 = await cluster.start("p2", {
        roles: ["publisher"],
        env: { OUTBOX_BATCH_SIZE: "7" },
      });
      await until(async () => (await unpublished(db)) === 0, 60_000, "outbox publicada");

      expect(await p1.metric("outbox_pending_total")).toBe(0);
      expect(await p2.metric("outbox_lag_seconds")).toBe(0);
      await expectAllEventsPublished(ctx);
    }));

  test.each([
    ["publisher_before_send", "antes de enviar ao SQS"],
    ["publisher_after_send", "depois de enviar e antes de marcar a outbox"],
  ])("SIGKILL do publisher %s (%s): o lease devolve as mensagens e nenhuma se perde", (point) =>
    scenario(async (ctx) => {
      const { db, cluster } = ctx;
      await seedOutbox(ctx);
      const doomed = await cluster.start("doomed", {
        roles: ["publisher"],
        crash: { point },
      });

      await until(() => !doomed.alive, 30_000, "publisher morrer");
      expect(await unpublished(db)).toBeGreaterThan(0); // a outbox NÃO foi marcada

      await cluster.start("rescuer", { roles: ["publisher"] });
      await until(async () => (await unpublished(db)) === 0, 60_000, "outbox publicada");
      await expectAllEventsPublished(ctx);
    }),
  );
});

describe("(7) ROLLBACK/REFUND antes da referência", () => {
  test("REFUND e cadeia ROLLBACK←WIN antes da BET, reprocessadores em 2 processos: cada um aplicado uma vez", () =>
    scenario(async (ctx) => {
      const { db, cluster } = ctx;
      const consumer = await cluster.start("consumer", { roles: ["consumer"] });
      const r1 = await cluster.start("r1", { roles: ["reprocessor"] });
      const r2 = await cluster.start("r2", { roles: ["reprocessor"] });
      const w = cluster.api(consumer);
      const refunds = await wallets(w, 4, "100.00");
      const chains = await wallets(w, 4, "100.00");

      for (const wallet of refunds) {
        const { res } = await w.send(wallet, {
          externalTransactionId: "refund",
          kind: "REFUND",
          referenceExternalTransactionId: "bet",
          money: money("25.00"),
        });
        expect(res.status).toBe(202); // referência ainda inexistente
      }
      for (const wallet of chains) {
        // WIN depois ROLLBACK, e ambos antes da BET que tudo referencia.
        await sendToInput(
          cluster.sqs,
          cluster.urls.transactions,
          wagerMessage(w, wallet, {
            externalTransactionId: "rollback",
            kind: "ROLLBACK",
            referenceExternalTransactionId: "win",
            money: money("40.00"),
          }),
        );
        await sendToInput(
          cluster.sqs,
          cluster.urls.transactions,
          wagerMessage(w, wallet, {
            externalTransactionId: "win",
            kind: "WIN",
            referenceExternalTransactionId: "bet",
            money: money("40.00"),
          }),
        );
      }
      await until(
        async () => (await count(db, "wager_transactions", "status = 'PENDING_REFERENCE'")) === 12,
        30_000,
        "12 pendências",
      );

      // Só agora as BETs chegam (por SQS, a um terceiro processo).
      for (const wallet of [...refunds, ...chains]) {
        await sendToInput(
          cluster.sqs,
          cluster.urls.transactions,
          wagerMessage(w, wallet, { externalTransactionId: "bet", money: money("25.00") }),
        );
      }
      await until(async () => (await unresolved(db)) === 0, 90_000, "pendências resolvidas");

      for (const wallet of refunds) {
        expect(await balanceOf(db, wallet.id)).toBe("100.00"); // BET debitou, REFUND creditou, uma vez
        expect(await w.ledgerCount(wallet.id)).toBe(3);
      }
      for (const wallet of chains) {
        expect(await balanceOf(db, wallet.id)).toBe("75.00"); // −25 +40 −40
        expect(await w.ledgerCount(wallet.id)).toBe(4);
      }
      expect(await count(db, "wager_transactions", "status = 'REJECTED'")).toBe(0);
      expect(
        await count(
          db,
          "wager_transactions",
          "status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK','WIN')",
        ),
      ).toBe(12);
      // Os reprocessadores trabalharam (a soma é exata, qualquer que seja a divisão entre eles).
      const resolved =
        (await total([r1, r2, consumer], "wager_transactions_total", {
          status: "PROCESSED",
          kind: "REFUND",
        })) +
        (await total([r1, r2, consumer], "wager_transactions_total", {
          status: "PROCESSED",
          kind: "ROLLBACK",
        })) +
        (await total([r1, r2, consumer], "wager_transactions_total", {
          status: "PROCESSED",
          kind: "WIN",
        }));
      expect(resolved).toBe(12);
    }));

  test("referência que nunca chega: após o limite vira REJECTED REFERENCE_NOT_FOUND, com evento, sem mexer no saldo", () =>
    scenario(async ({ db, cluster }) => {
      const env = { PENDING_REFERENCE_MAX_ATTEMPTS: "2", PENDING_REFERENCE_TTL_MS: "600000" };
      const api = await cluster.start("api", { roles: ["publisher"], env });
      await cluster.start("r1", { roles: ["reprocessor"], env });
      await cluster.start("r2", { roles: ["reprocessor"], env });
      const w = cluster.api(api);
      const [wallet] = (await wallets(w, 1, "100.00")) as [ApiWallet];

      const { res } = await w.send(wallet, {
        externalTransactionId: "refund",
        kind: "REFUND",
        referenceExternalTransactionId: "bet-que-nunca-chega",
        money: money("25.00"),
      });
      expect(res.status).toBe(202);

      await until(async () => (await unresolved(db)) === 0, 60_000, "pendência esgotada");

      const row = await w.row(res.body.transactionId);
      expect(row.status).toBe("REJECTED");
      expect(row.failure_code).toBe("REFERENCE_NOT_FOUND");
      expect(await balanceOf(db, wallet.id)).toBe("100.00");
      expect(await w.eventTypes(res.body.transactionId)).toContain("WagerTransactionRejected");
    }));
});

describe("(8) reinício do serviço", () => {
  test("shutdown gracioso no meio da carga: nada em voo, consistente; um processo novo termina exatamente uma vez", () =>
    scenario(async (ctx) => {
      const { db, cluster } = ctx;
      const first = [
        await cluster.start("n1", { roles: ALL_WORKERS }),
        await cluster.start("n2", { roles: ALL_WORKERS }),
      ];
      const w = cluster.api(first[0] as Node);
      const set = await wallets(w, 8, "1000.00");
      const messages = set.flatMap((wallet) => bets(w, wallet, 15, "sqs"));
      await Promise.all(
        messages.map((m) => sendToInput(cluster.sqs, cluster.urls.transactions, m)),
      );
      await until(async () => (await processedBets(db)) >= 20, 60_000, "carga em andamento");

      await Promise.all(first.map((node) => node.stop()));
      expect(first.every((node) => !node.alive)).toBe(true);
      // O consumidor devolveu à fila o que estava em voo: nada preso esperando visibilidade.
      expect(await cluster.inFlight()).toBe(0);
      const midway = await processedBets(db);
      expect(midway).toBeGreaterThanOrEqual(20);
      await expectInvariants(db); // consistente com a carga pela metade

      const second = await cluster.start("n3", { roles: ALL_WORKERS });
      await until(
        async () => (await processedBets(db)) === messages.length,
        90_000,
        "carga concluída",
      );
      await until(async () => (await cluster.inputDepth()) === 0, 30_000, "fila vazia");
      await until(async () => (await unpublished(db)) === 0, 30_000, "outbox publicada");

      for (const wallet of set) {
        expect(await balanceOf(db, wallet.id)).toBe("850.00"); // 15 × 10,00 debitados, uma vez cada
        expect(await w.ledgerCount(wallet.id)).toBe(16);
      }
      expect(await count(db, "wager_transactions", "kind = 'BET'")).toBe(messages.length);

      // Idempotência persistente: o mesmo corpo/chave de antes do reinício vira replay.
      const { idempotencyKey, ...replayBody } = messages[0]?.data ?? {};
      const again = await second.request("POST", "/wagering/transactions", {
        body: replayBody,
        headers: { "idempotency-key": String(idempotencyKey) },
      });
      expect(again.status).toBe(200);
      expect(again.body.idempotentReplay).toBe(true);
      expect(await balanceOf(db, (set[0] as ApiWallet).id)).toBe("850.00");
    }));

  test("SIGKILL de 2 de 3 processos no meio da carga: o resto + um substituto terminam, cada mensagem uma vez", () =>
    scenario(async (ctx) => {
      const { db, cluster } = ctx;
      const nodes = [
        await cluster.start("n1", { roles: ALL_WORKERS }),
        await cluster.start("n2", { roles: ALL_WORKERS }),
        await cluster.start("n3", { roles: ALL_WORKERS }),
      ];
      const w = cluster.api(nodes[0] as Node);
      const set = await wallets(w, 10, "1000.00");
      const messages = set.flatMap((wallet) => bets(w, wallet, 15, "sqs"));
      await Promise.all(
        messages.map((m) => sendToInput(cluster.sqs, cluster.urls.transactions, m)),
      );
      await until(async () => (await processedBets(db)) >= 20, 60_000, "carga em andamento");

      await Promise.all([(nodes[1] as Node).kill(), (nodes[2] as Node).kill()]);
      await expectInvariants(db); // o que foi commitado está íntegro, apesar do kill -9

      await cluster.start("n4", { roles: ALL_WORKERS });
      await until(
        async () => (await processedBets(db)) === messages.length,
        150_000,
        "carga concluída após o kill",
      );
      await until(async () => (await cluster.inputDepth()) === 0, 60_000, "fila vazia");
      await until(async () => (await unpublished(db)) === 0, 60_000, "outbox publicada");

      for (const wallet of set) {
        expect(await balanceOf(db, wallet.id)).toBe("850.00");
        expect(await w.ledgerCount(wallet.id)).toBe(16);
      }
      expect(await count(db, "wager_transactions", "kind = 'BET'")).toBe(messages.length);
      await expectAllEventsPublished(ctx);
    }));
});

describe("/metrics com banco real", () => {
  test("expõe as métricas do RNF-OBS-02 com valores coerentes após processar", () =>
    scenario(async ({ cluster }) => {
      const node = await cluster.start("n1", { roles: [] });
      const w = cluster.api(node);
      const [wallet] = (await wallets(w, 1, "100.00")) as [ApiWallet];
      await w.send(wallet, { externalTransactionId: "ok", money: money("10.00") });
      await w.send(wallet, { externalTransactionId: "caro", money: money("500.00") });

      const text = await node.metricsText();

      expect(
        sumSeries(text, "wager_transactions_total", { status: "PROCESSED", kind: "BET" }),
      ).toBe(1);
      expect(sumSeries(text, "wager_transactions_total", { status: "REJECTED", kind: "BET" })).toBe(
        1,
      );
      expect(sumSeries(text, "wager_processing_duration_seconds_count", { source: "http" })).toBe(
        2,
      );
      expect(sumSeries(text, "wallet_lock_wait_seconds_count")).toBe(2);
      expect(sumSeries(text, "outbox_pending_total")).toBeGreaterThan(0);
      expect(sumSeries(text, "process_cpu_user_seconds_total")).toBeGreaterThan(0);
    }));
});
