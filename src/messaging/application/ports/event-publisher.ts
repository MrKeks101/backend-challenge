import type { OutboxMessage } from "../../domain";

export const EVENT_PUBLISHER = Symbol("EventPublisher");

/**
 * Entrega um evento da outbox ao broker. Lança se a entrega não for confirmada. É at-least-once:
 * a mesma mensagem pode ser entregue mais de uma vez, e o consumidor deduplica por `eventId`.
 */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}
