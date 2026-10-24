import { requireDate, requireText } from "./guards";
import { assertPlainJson, deepFreeze } from "./plain-json";

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** Envelope serializado, gravado no payload da outbox e publicado no SQS. */
export interface IntegrationEventJson<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

/** Contexto que o chamador fornece ao construir um evento (o domínio não gera ids nem lê o relógio). */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

/**
 * Envelope de evento de integração. Cada evento concreto é uma subclasse que fixa `eventType` e
 * `version` NO TIPO. O `data` precisa ser JSON puro (dinheiro como `MoneyProps`, datas ISO) e é
 * congelado: um evento já criado não muda.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly data: Readonly<T>;
  private readonly _occurredAt: Date;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = requireText(props.eventId, "eventId");
    this.aggregateId = requireText(props.aggregateId, "aggregateId");
    this.correlationId = requireText(props.correlationId, "correlationId");
    if (props.causationId !== undefined) {
      this.causationId = requireText(props.causationId, "causationId");
    }
    this._occurredAt = requireDate(props.occurredAt, "occurredAt");
    assertPlainJson(props.data, "event data");
    this.data = deepFreeze(structuredClone(props.data));
  }

  get occurredAt(): Date {
    return new Date(this._occurredAt.getTime());
  }

  toJSON(): IntegrationEventJson<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined ? { causationId: this.causationId } : {}),
      occurredAt: this._occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}
