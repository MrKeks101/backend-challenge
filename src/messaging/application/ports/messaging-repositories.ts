import type { InboxMessage, OutboxMessage } from "../../domain";

export const INBOX_REPOSITORY = Symbol("InboxRepository");
export const OUTBOX_REPOSITORY = Symbol("OutboxRepository");

export interface InboxRepository {
  /**
   * `INSERT … ON CONFLICT (consumer_name, message_id) DO NOTHING`. `true` = primeira vez que a
   * mensagem é vista; `false` = duplicata (nada gravado).
   */
  tryReceive(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  /** Marca como processada. Lança `OptimisticLockError` se já estava processada ou não existe. */
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
  findById(id: string): Promise<OutboxMessage | null>;
  /**
   * Reivindica até `limit` mensagens vencidas (`FOR UPDATE SKIP LOCKED`) em ordem de
   * `occurredAt`, empurrando `next_attempt_at` para `now + leaseMs` (lease). Exige transação.
   */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  /** Lança `OptimisticLockError` se já estava publicada ou não existe. */
  markPublished(message: OutboxMessage): Promise<void>;
  /** Grava `attempts`, `nextAttemptAt` e `lastError` de uma mensagem ainda não publicada. */
  saveRetry(message: OutboxMessage): Promise<void>;
  /** Mensagens ainda não publicadas e `occurredAt` da mais antiga (métricas `outbox_*`). */
  backlog(): Promise<{ pending: number; oldestOccurredAt: Date | null }>;
}
