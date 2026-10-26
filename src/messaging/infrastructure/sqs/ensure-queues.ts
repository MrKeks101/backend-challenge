import { CreateQueueCommand, GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";

export interface QueueNames {
  /** Entrada: comandos `WagerTransactionRequested` (consumida no M9). */
  transactions: string;
  /** DLQ da entrada. */
  transactionsDlq: string;
  /** Saída: eventos de integração publicados pela outbox. */
  events: string;
}

export type QueueUrls = QueueNames;

/** Tentativas de recebimento antes do SQS enviar a mensagem para a DLQ (redrive nativo). */
export const MAX_RECEIVE_COUNT = 5;

export const queueNames = (prefix = ""): QueueNames => ({
  transactions: `${prefix}wager-transactions.fifo`,
  transactionsDlq: `${prefix}wager-transactions-dlq.fifo`,
  events: `${prefix}wager-events.fifo`,
});

const FIFO = { FifoQueue: "true", ContentBasedDeduplication: "false" } as const;

async function createQueue(
  sqs: SQSClient,
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
  );
  if (!QueueUrl) throw new Error(`CreateQueue returned no URL for ${name}`);
  return QueueUrl;
}

/**
 * Cria as três filas FIFO se ainda não existirem e devolve as URLs. É idempotente: `CreateQueue`
 * com os mesmos atributos devolve a fila existente, então vários processos podem chamá-la ao
 * subir. A DLQ vem primeiro porque a fila de entrada aponta para ela (redrive nativo).
 */
export async function ensureQueues(sqs: SQSClient, names: QueueNames): Promise<QueueUrls> {
  const transactionsDlq = await createQueue(sqs, names.transactionsDlq, { ...FIFO });

  const attributes = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: transactionsDlq, AttributeNames: ["QueueArn"] }),
  );
  const dlqArn = attributes.Attributes?.QueueArn;
  if (!dlqArn) throw new Error(`the DLQ ${names.transactionsDlq} has no ARN`);

  const transactions = await createQueue(sqs, names.transactions, {
    ...FIFO,
    VisibilityTimeout: "30",
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: dlqArn,
      maxReceiveCount: MAX_RECEIVE_COUNT,
    }),
  });
  const events = await createQueue(sqs, names.events, { ...FIFO });

  return { transactions, transactionsDlq, events };
}
