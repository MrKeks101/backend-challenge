import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { OutboxPublisher } from "../../src/messaging/application/outbox-publisher";
import type { EventPublisher } from "../../src/messaging/application/ports/event-publisher";
import { OutboxMessage } from "../../src/messaging/domain";
import type { QueueUrls } from "../../src/messaging/infrastructure/sqs/ensure-queues";
import { QueueRegistry } from "../../src/messaging/infrastructure/sqs/sqs.module";
import { SqsEventPublisher } from "../../src/messaging/infrastructure/sqs/sqs-event-publisher";
import type { Env } from "../../src/shared/infrastructure/config/env";
import type { Clock } from "../../src/shared/kernel";
import { WagerTransactionProcessed } from "../../src/wagering/domain";
import type { TestDatabase } from "./database";
import { TEST_SQS_ENDPOINT } from "./infra";
import { brl } from "./money";
import { newTx, type openWalletInDb } from "./persisted-flow";
import { at, eventContext } from "./wagering";

/** Endpoint onde ninguém escuta: a conexão é recusada na hora (falha REAL de rede, sem mock). */
export const DEAD_SQS_ENDPOINT = "http://127.0.0.1:9";

export function sqsClient(endpoint = TEST_SQS_ENDPOINT): SQSClient {
  return new SQSClient({
    region: "us-east-1",
    endpoint,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 1_000, requestTimeout: 5_000 },
  });
}

/** Prefixo único por teste: o MiniStack é compartilhado, então cada teste ganha as suas filas. */
export const uniquePrefix = (): string =>
  `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}-`;

export function registryFor(sqs: SQSClient, prefix: string): QueueRegistry {
  return new QueueRegistry(sqs, { SQS_QUEUE_PREFIX: prefix } as Env);
}

/** Relógio controlado: o lease e o backoff dependem de `now`, então o teste avança o tempo à mão. */
export class FakeClock implements Clock {
  constructor(private current: Date = new Date()) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface ReceivedEvent {
  body: Record<string, unknown>;
  eventId: string;
  groupId: string;
  eventType: string;
}

/**
 * Esvazia a fila (recebendo e apagando) e devolve tudo o que veio, em ordem de chegada. Para
 * depois de duas leituras seguidas vazias: a primeira pode vir vazia por causa do long poll.
 */
export async function drainQueue(sqs: SQSClient, queueUrl: string): Promise<ReceivedEvent[]> {
  const received: ReceivedEvent[] = [];
  let empty = 0;
  while (empty < 2) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
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
      received.push({
        body: JSON.parse(message.Body ?? "null") as Record<string, unknown>,
        eventId: message.MessageAttributes?.eventId?.StringValue ?? "",
        eventType: message.MessageAttributes?.eventType?.StringValue ?? "",
        groupId: message.Attributes?.MessageGroupId ?? "",
      });
      await sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
    }
  }
  return received;
}

/** Quantas mensagens a fila tem (visíveis + em voo), sem consumir nenhuma. */
export async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<number> {
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  const attrs = res.Attributes ?? {};
  return (
    Number(attrs.ApproximateNumberOfMessages ?? 0) + // allow-number: contagem pequena do SQS
    Number(attrs.ApproximateNumberOfMessagesNotVisible ?? 0) // allow-number: contagem pequena do SQS
  );
}

export interface PublisherRig {
  sqs: SQSClient;
  queues: QueueRegistry;
  urls: () => Promise<QueueUrls>;
  /** Publicador real do SQS (a mesma classe usada em produção). */
  sqsPublisher: SqsEventPublisher;
  clock: FakeClock;
  build(options?: {
    publisher?: EventPublisher;
    batchSize?: number;
    leaseMs?: number;
  }): OutboxPublisher;
}

/** Monta publishers sobre o banco de teste e uma fila SQS real e exclusiva do teste. */
export function createPublisherRig(
  db: TestDatabase,
  options: { endpoint?: string; clock?: FakeClock; prefix?: string } = {},
): PublisherRig {
  const sqs = sqsClient(options.endpoint);
  const queues = registryFor(sqs, options.prefix ?? uniquePrefix());
  const sqsPublisher = new SqsEventPublisher(sqs, queues);
  const clock = options.clock ?? new FakeClock();
  return {
    sqs,
    queues,
    urls: () => queues.ensure(),
    sqsPublisher,
    clock,
    build: (options = {}) =>
      new OutboxPublisher(db.uow, db.outbox, options.publisher ?? sqsPublisher, clock, {
        batchSize: options.batchSize ?? 20,
        leaseMs: options.leaseMs ?? 30_000,
        jitter: () => 1,
      }),
  };
}

type TestWallet = Awaited<ReturnType<typeof openWalletInDb>>;

/** Monta (sem gravar) a mensagem de outbox de um evento já vencido em `occurredAt`. */
export function buildOutboxMessage(
  db: TestDatabase,
  wallet: TestWallet,
  occurredAt: Date = at(0),
): OutboxMessage {
  const tx = newTx(db, wallet);
  tx.markProcessed(undefined, at(1), brl("1.00"));
  const event = WagerTransactionProcessed.from(
    tx,
    eventContext({ eventId: db.ids.next(), occurredAt }),
  );
  return OutboxMessage.enqueue(event, wallet.id);
}

/** Grava (e commita) um evento na outbox, já vencido em `occurredAt`. */
export async function enqueueEvent(
  db: TestDatabase,
  wallet: TestWallet,
  occurredAt: Date = at(0),
): Promise<OutboxMessage> {
  const message = buildOutboxMessage(db, wallet, occurredAt);
  await db.uow.run(() => db.outbox.add(message));
  return message;
}

/** Estado atual da mensagem no banco (domínio reidratado). */
export async function outboxRow(db: TestDatabase, id: string): Promise<OutboxMessage> {
  const message = await db.outbox.findById(id);
  if (!message) throw new Error(`outbox message ${id} not found`);
  return message;
}

export async function unpublishedCount(db: TestDatabase): Promise<number> {
  const [row] = await db.sql<{ n: string }[]>(
    "SELECT count(*)::text AS n FROM outbox_messages WHERE published_at IS NULL",
  );
  return Number(row?.n ?? 0); // allow-number: contagem pequena de linhas
}
