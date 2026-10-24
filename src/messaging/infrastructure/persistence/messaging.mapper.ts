import { InboxMessage, OutboxMessage } from "../../domain";

export interface InboxRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface OutboxRecord {
  id: string;
  aggregateId: string;
  messageGroupId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
  lastError: string | null;
}

export const inboxMapper = {
  toRecord(message: InboxMessage): InboxRecord {
    return {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    };
  },

  toDomain(record: InboxRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: record.processedAt ?? undefined,
    });
  },
};

export const outboxMapper = {
  toRecord(message: OutboxMessage): OutboxRecord {
    return {
      id: message.id,
      aggregateId: message.aggregateId,
      messageGroupId: message.messageGroupId,
      eventType: message.eventType,
      payload: message.payload as Record<string, unknown>,
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt,
      publishedAt: message.publishedAt ?? null,
      lastError: message.lastError ?? null,
    };
  },

  toDomain(record: OutboxRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      messageGroupId: record.messageGroupId,
      eventType: record.eventType,
      payload: record.payload,
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt,
      publishedAt: record.publishedAt ?? undefined,
      lastError: record.lastError ?? undefined,
    });
  },
};
