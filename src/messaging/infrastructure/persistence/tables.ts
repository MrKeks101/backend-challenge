import { defineTable } from "../../../shared/infrastructure/persistence/table-def";

export const inboxTable = defineTable("inbox_messages", "InboxMessageRecord", {
  consumerName: { column: "consumer_name", type: "text", primary: true },
  messageId: { column: "message_id", type: "text", primary: true },
  payloadHash: { column: "payload_hash", type: "char", length: 64 },
  receivedAt: { column: "received_at", type: "timestamptz" },
  processedAt: { column: "processed_at", type: "timestamptz", nullable: true },
});

export const outboxTable = defineTable("outbox_messages", "OutboxMessageRecord", {
  id: { column: "id", type: "uuid", primary: true },
  aggregateId: { column: "aggregate_id", type: "text" },
  messageGroupId: { column: "message_group_id", type: "text" },
  eventType: { column: "event_type", type: "text" },
  payload: { column: "payload", type: "jsonb" },
  occurredAt: { column: "occurred_at", type: "timestamptz" },
  attempts: { column: "attempts", type: "integer" },
  nextAttemptAt: { column: "next_attempt_at", type: "timestamptz" },
  publishedAt: { column: "published_at", type: "timestamptz", nullable: true },
  lastError: { column: "last_error", type: "text", nullable: true },
});
