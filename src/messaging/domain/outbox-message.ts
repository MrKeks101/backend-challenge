import {
  assertPlainJson,
  type BackoffConfig,
  backoffDelayMs,
  deepFreeze,
  type IntegrationEvent,
  type IntegrationEventJson,
  requireDate,
  requireText,
} from "../../shared/kernel";
import { InvalidMessageStateError } from "./errors";

/** Backoff entre republicações: 1 s dobrando até 5 min. */
export const OUTBOX_BACKOFF: BackoffConfig = { baseMs: 1_000, capMs: 300_000 };

const MAX_ERROR_LENGTH = 500;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  /** Grupo FIFO do SQS (a walletId): eventos do mesmo grupo mantêm ordem relativa. */
  messageGroupId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | undefined;
  lastError: string | undefined;
}

export interface ScheduleRetryOptions {
  /** Motivo curto da falha (sem dados financeiros); truncado em 500 caracteres. */
  reason?: string;
  /** Fator de jitter, p.ex. 0.8–1.2; 1 = sem jitter. */
  jitter?: number;
}

/**
 * Evento de integração gravado na MESMA transação SQL da alteração financeira e publicado depois
 * por um worker. `nextAttemptAt` serve ao mesmo tempo de vencimento e de lease do publisher.
 */
export class OutboxMessage {
  private readonly _occurredAt: Date;
  private _attempts: number;
  private _nextAttemptAt: Date;
  private _publishedAt: Date | undefined;
  private _lastError: string | undefined;

  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly messageGroupId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    occurredAt: Date,
    attempts: number,
    nextAttemptAt: Date,
    publishedAt: Date | undefined,
    lastError: string | undefined,
  ) {
    this._occurredAt = new Date(occurredAt.getTime());
    this._attempts = attempts;
    this._nextAttemptAt = new Date(nextAttemptAt.getTime());
    this._publishedAt = publishedAt ? new Date(publishedAt.getTime()) : undefined;
    this._lastError = lastError;
  }

  /** Enfileira o evento: o envelope serializado vira o payload e a mensagem já nasce vencida. */
  static enqueue(event: IntegrationEvent<unknown>, messageGroupId: string): OutboxMessage {
    const envelope: IntegrationEventJson<unknown> = structuredClone(event.toJSON());
    assertPlainJson(envelope, "outbox payload");
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      requireText(messageGroupId, "messageGroupId"),
      event.eventType,
      deepFreeze(envelope as unknown as Record<string, unknown>),
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
      undefined,
    );
  }

  /** Reconstrução a partir da persistência. NÃO revalida. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.messageGroupId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get occurredAt(): Date {
    return new Date(this._occurredAt.getTime());
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return new Date(this._nextAttemptAt.getTime());
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt ? new Date(this._publishedAt.getTime()) : undefined;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  /** Ainda não publicada. */
  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Pendente e com `nextAttemptAt` já alcançado (o vencimento é inclusivo). */
  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError("outbox message was already published");
    }
    this._publishedAt = requireDate(at, "at");
    this._lastError = undefined;
  }

  /** Incrementa `attempts` e calcula o próximo `nextAttemptAt` com backoff exponencial. */
  scheduleRetry(now: Date, options: ScheduleRetryOptions = {}): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError("a published outbox message cannot be retried");
    }
    const base = requireDate(now, "now");
    const attempts = this._attempts + 1;
    this._attempts = attempts;
    this._nextAttemptAt = new Date(
      base.getTime() + backoffDelayMs(attempts, OUTBOX_BACKOFF, options.jitter ?? 1),
    );
    if (options.reason !== undefined) {
      this._lastError = options.reason.slice(0, MAX_ERROR_LENGTH);
    }
  }
}
