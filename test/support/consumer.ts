import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { v7 } from "uuid";
import type { QueueUrls } from "../../src/messaging/infrastructure/sqs/ensure-queues";
import type { TestDatabase } from "./database";
import { startApi, type TestApi } from "./http-app";
import { queueDepth, registryFor, sqsClient, uniquePrefix } from "./messaging";
import { type ApiWallet, type SubmitBody, WageringApi } from "./wagering-api";

/** Espera uma condição de fato (sem tempo fixo): consulta até valer ou estourar o prazo. */
export async function until(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 20_000,
  what = "condição",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`${what} não atingida no prazo (${timeoutMs} ms)`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export interface WagerRequestedMessage {
  messageId: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

/** Mensagem `WagerTransactionRequested` válida para a wallet (o `data` = corpo HTTP + key). */
export function wagerMessage(
  w: WageringApi,
  wallet: ApiWallet,
  overrides: SubmitBody & { idempotencyKey?: string } = {},
  messageId = `msg-${v7()}`,
): WagerRequestedMessage {
  const { idempotencyKey, ...rest } = overrides;
  const body = w.body(wallet, rest);
  return {
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: { ...body, idempotencyKey: idempotencyKey ?? w.defaultKey(body) },
  };
}

/** Publica na fila de entrada, como faria o produtor. */
export async function sendToInput(
  sqs: SQSClient,
  queueUrl: string,
  message: unknown,
  options: { group?: string; dedup?: string } = {},
): Promise<void> {
  const body = typeof message === "string" ? message : JSON.stringify(message);
  const asMessage = message as Partial<WagerRequestedMessage>;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: options.group ?? String(asMessage.data?.walletId ?? "no-wallet"),
      MessageDeduplicationId: options.dedup ?? `dedup-${v7()}`,
    }),
  );
}

export interface DeadLetter {
  body: string;
  attrs: Record<string, string>;
  groupId: string;
}

/** Esvazia a DLQ devolvendo corpo e atributos de erro de cada mensagem. */
export async function drainDlq(sqs: SQSClient, dlqUrl: string): Promise<DeadLetter[]> {
  const letters: DeadLetter[] = [];
  let empty = 0;
  while (empty < 2) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );
    const messages = res.Messages ?? [];
    if (messages.length === 0) {
      empty++;
      continue;
    }
    empty = 0;
    for (const message of messages) {
      const attrs: Record<string, string> = {};
      for (const [name, value] of Object.entries(message.MessageAttributes ?? {})) {
        attrs[name] = value.StringValue ?? "";
      }
      letters.push({
        body: message.Body ?? "",
        attrs,
        groupId: message.Attributes?.MessageGroupId ?? "",
      });
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    }
  }
  return letters;
}

export interface ConsumerHarness {
  api: TestApi;
  w: WageringApi;
  sqs: SQSClient;
  prefix: string;
  urls: QueueUrls;
  /** Envia ao input e devolve a mensagem. */
  send(message: unknown, options?: { group?: string; dedup?: string }): Promise<void>;
  /** A fila de entrada está vazia (nada visível nem em voo)? */
  inputIsEmpty(): Promise<boolean>;
  close(): Promise<void>;
}

/** API real + consumidor ligado + filas próprias. Retry de visibilidade imediato (base 0). */
export async function startConsumerHarness(
  db: TestDatabase,
  options: { roles?: string; env?: Record<string, string> } = {},
): Promise<ConsumerHarness> {
  const prefix = uniquePrefix();
  const api = await startApi(db, {
    roles: options.roles ?? "api,consumer",
    env: {
      SQS_QUEUE_PREFIX: prefix,
      CONSUMER_WAIT_SECONDS: "1",
      CONSUMER_RETRY_BASE_SECONDS: "0",
      CONSUMER_POLLERS: "2",
      ...options.env,
    },
  });
  const sqs = sqsClient();
  const urls = await registryFor(sqs, prefix).ensure();
  let closed = false;
  return {
    api,
    w: new WageringApi(api, db),
    sqs,
    prefix,
    urls,
    send: (message, sendOptions) => sendToInput(sqs, urls.transactions, message, sendOptions),
    inputIsEmpty: async () => (await queueDepth(sqs, urls.transactions)) === 0,
    async close() {
      if (closed) return;
      closed = true;
      await api.close();
      sqs.destroy();
    },
  };
}
