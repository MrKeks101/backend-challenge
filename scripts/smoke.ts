/**
 * Teste de fumaça ponta a ponta contra o sistema JÁ NO AR (`docker compose up --build`):
 * HTTP, idempotência, rejeição, reversão, referência fora de ordem (reprocessador), entrada por SQS
 * (consumidor), reconciliação, eventos na fila de saída (publisher) e métricas.
 * Uso: `bun run smoke` (API_URL e SQS_ENDPOINT sobrescrevem os padrões do compose).
 */
import { GetQueueAttributesCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { v7 } from "uuid";
import { ensureQueues, queueNames } from "../src/messaging/infrastructure/sqs/ensure-queues";

const API = process.env.API_URL ?? "http://localhost:3000";
const SQS_ENDPOINT = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
const PROVIDER = "smoke-provider";
const run = v7(); // isola execuções repetidas: (providerId, externalTransactionId) é único

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "  ok  " : " FALHA"}  ${label}${ok ? "" : `  -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

interface Reply {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: respostas JSON são inspecionadas campo a campo
  body: Record<string, any>;
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; key?: string } = {},
): Promise<Reply> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.key ? { "idempotency-key": options.key } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

async function until(what: string, condition: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  check(`${what} (prazo de ${timeoutMs} ms)`, false);
  return false;
}

const money = (amount: string) => ({ amount, currency: "BRL" });

async function newWallet(balance = "100.00") {
  const res = await call("POST", "/wallets", {
    body: { playerId: v7(), initialBalance: money(balance) },
  });
  return { res, id: res.body.id as string, playerId: res.body.playerId as string };
}

function transaction(
  wallet: { id: string; playerId: string },
  externalTransactionId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    providerId: PROVIDER,
    externalTransactionId: `${externalTransactionId}-${run}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: money("30.00"),
    ...extra,
  };
}

const keyOf = (body: { providerId: unknown; externalTransactionId: unknown }) =>
  `${body.providerId}:${body.externalTransactionId}`;

const submit = (body: ReturnType<typeof transaction>) =>
  call("POST", "/wagering/transactions", { body, key: keyOf(body) });

console.log(`API ${API} | SQS ${SQS_ENDPOINT}\n`);

console.log("1. Prontidão");
const ready = await call("GET", "/health/ready");
check("GET /health/ready responde 200 (PostgreSQL e SQS alcançáveis)", ready.status === 200, ready);

console.log("2. Wallet e BET");
const wallet = await newWallet();
check(
  "POST /wallets -> 201 com saldo 100.00",
  wallet.res.status === 201 && wallet.res.body.balance?.amount === "100.00",
  wallet.res,
);
const bet = transaction(wallet, "bet");
const first = await submit(bet);
check(
  "BET de 30.00 -> 200 PROCESSED, saldo 70.00",
  first.status === 200 &&
    first.body.status === "PROCESSED" &&
    first.body.balance?.amount === "70.00",
  first,
);

console.log("3. Idempotência");
const replay = await submit(bet);
check(
  "mesma chave e payload -> replay do resultado original (um só débito)",
  replay.status === 200 &&
    replay.body.idempotentReplay === true &&
    replay.body.transactionId === first.body.transactionId,
  replay,
);
const conflict = await call("POST", "/wagering/transactions", {
  body: { ...bet, money: money("31.00") },
  key: keyOf(bet),
});
check("mesma chave, payload diferente -> 409", conflict.status === 409, conflict);

console.log("4. Rejeição de negócio");
const rich = await submit(transaction(wallet, "rich", { money: money("999.00") }));
check(
  "aposta acima do saldo -> 422 INSUFFICIENT_FUNDS",
  rich.status === 422 && rich.body.failureCode === "INSUFFICIENT_FUNDS",
  rich,
);

console.log("5. Reversão");
const refund = await submit(
  transaction(wallet, "refund", {
    kind: "REFUND",
    referenceExternalTransactionId: bet.externalTransactionId,
  }),
);
check(
  "REFUND da BET -> 200, saldo volta a 100.00",
  refund.status === 200 && refund.body.balance?.amount === "100.00",
  refund,
);

console.log("6. Referência fora de ordem (reprocessador)");
const late = await newWallet();
const lateBet = transaction(late, "late-bet");
const early = await submit(
  transaction(late, "early-refund", {
    kind: "REFUND",
    referenceExternalTransactionId: lateBet.externalTransactionId,
  }),
);
check(
  "REFUND antes da BET -> 202 PENDING_REFERENCE",
  early.status === 202 && early.body.status === "PENDING_REFERENCE",
  early,
);
await submit(lateBet);
await until("REFUND pendente resolvido pelo reprocessador", async () => {
  const state = await call("GET", `/wagering/transactions/${early.body.transactionId}`);
  return state.body.status === "PROCESSED";
});
const lateWallet = await call("GET", `/wallets/${late.id}`);
check(
  "saldo da wallet final 100.00 (BET debitou, REFUND creditou, uma vez cada)",
  lateWallet.body.balance?.amount === "100.00",
  lateWallet,
);

console.log("7. Entrada por SQS (consumidor)");
const sqs = new SQSClient({
  region: "us-east-1",
  endpoint: SQS_ENDPOINT,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const queues = await ensureQueues(sqs, queueNames(process.env.SQS_QUEUE_PREFIX ?? ""));
const viaSqs = await newWallet();
const sqsBody = transaction(viaSqs, "sqs-bet");
await sqs.send(
  new SendMessageCommand({
    QueueUrl: queues.transactions,
    MessageGroupId: viaSqs.id,
    MessageDeduplicationId: v7(),
    MessageBody: JSON.stringify({
      messageId: `smoke-${run}`,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: { ...sqsBody, idempotencyKey: keyOf(sqsBody) },
    }),
  }),
);
const arrived = await until("mensagem SQS processada pelo consumidor", async () => {
  const state = await call(
    "GET",
    `/providers/${PROVIDER}/wagering/transactions/${sqsBody.externalTransactionId}`,
  );
  return state.status === 200 && state.body.status === "PROCESSED";
});
if (arrived) {
  const viaSqsWallet = await call("GET", `/wallets/${viaSqs.id}`);
  check(
    "saldo da wallet 70.00 após a BET vinda do SQS",
    viaSqsWallet.body.balance?.amount === "70.00",
    viaSqsWallet,
  );
}

console.log("8. Reconciliação e ledger");
const recon = await call("POST", `/wallets/${wallet.id}/reconciliation`);
check("saldo == soma do ledger", recon.status === 200 && recon.body.consistent === true, recon);
const ledger = await call("GET", `/wallets/${wallet.id}/ledger`);
check(
  "ledger com abertura + BET + REFUND (3 lançamentos)",
  ledger.body.items?.length === 3,
  ledger,
);

console.log("9. Eventos (publisher) e métricas");
const published = await until("eventos na fila de saída", async () => {
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queues.events,
      AttributeNames: ["ApproximateNumberOfMessages"],
    }),
  );
  return Number(res.Attributes?.ApproximateNumberOfMessages ?? 0) > 0; // allow-number: contagem do SQS
});
check("o publisher entregou eventos em wager-events.fifo", published);
const metrics = await (await fetch(`${API}/metrics`)).text();
check("GET /metrics expõe wager_transactions_total", metrics.includes("wager_transactions_total"));
check("GET /metrics expõe outbox_lag_seconds", metrics.includes("outbox_lag_seconds"));

sqs.destroy();
console.log(failures === 0 ? "\nTudo certo." : `\n${failures} verificação(ões) falharam.`);
process.exit(failures === 0 ? 0 : 1);
