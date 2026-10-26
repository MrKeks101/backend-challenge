import { Inject, Injectable } from "@nestjs/common";
import { CLOCK } from "../../shared/application/tokens";
import { UNIT_OF_WORK, type UnitOfWork } from "../../shared/application/unit-of-work";
import { OptimisticLockError } from "../../shared/infrastructure/persistence/errors";
import type { Clock } from "../../shared/kernel";
import type { OutboxMessage } from "../domain";
import { EVENT_PUBLISHER, type EventPublisher } from "./ports/event-publisher";
import { OUTBOX_REPOSITORY, type OutboxRepository } from "./ports/messaging-repositories";

export const OUTBOX_PUBLISHER_CONFIG = Symbol("OutboxPublisherConfig");

export interface OutboxPublisherConfig {
  /** Máximo de mensagens reivindicadas por ciclo. */
  batchSize: number;
  /** Duração do lease: se o publisher morrer, a mensagem volta a ficar disponível depois disso. */
  leaseMs: number;
  /** Fator multiplicativo do backoff (p.ex. 0,8–1,2). Injetável para os testes serem determinísticos. */
  jitter: () => number;
}

export interface PublishCycleResult {
  claimed: number;
  published: number;
  /** Falhas de publicação que agendaram retry. */
  failed: number;
  /** Não tentadas neste ciclo porque uma anterior do MESMO grupo falhou (preserva a ordem). */
  skipped: number;
}

/**
 * Publica a outbox no broker (ARCHITECTURE §12.2). Um ciclo tem três tempos, cada um numa
 * transação CURTA — nunca há I/O de rede com transação aberta:
 *
 * 1. **Claim** (`SKIP LOCKED` + lease via `next_attempt_at`): publishers concorrentes recebem
 *    mensagens disjuntas, e um publisher morto devolve as suas quando o lease vence.
 * 2. **Publicar** no broker.
 * 3. **Marcar** como publicada, ou agendar retry com backoff.
 *
 * A publicação é at-least-once: se o processo morrer entre 2 e 3, outro publisher republica depois
 * do lease. Isso é esperado; o consumidor deduplica por `eventId` (AR-53).
 */
@Injectable()
export class OutboxPublisher {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OUTBOX_PUBLISHER_CONFIG) private readonly config: OutboxPublisherConfig,
  ) {}

  async runOnce(): Promise<PublishCycleResult> {
    const claimed = await this.uow.run(() =>
      this.outbox.claimDue(this.clock.now(), this.config.batchSize, this.config.leaseMs),
    );

    const result: PublishCycleResult = {
      claimed: claimed.length,
      published: 0,
      failed: 0,
      skipped: 0,
    };
    // Uma falha bloqueia o RESTO do grupo neste ciclo: publicar a seguinte inverteria a ordem
    // dos eventos da mesma wallet. As puladas ficam sob lease e voltam quando ele vence.
    const blockedGroups = new Set<string>();

    for (const message of claimed) {
      if (blockedGroups.has(message.messageGroupId)) {
        result.skipped++;
        continue;
      }
      try {
        await this.publisher.publish(message);
      } catch (error) {
        blockedGroups.add(message.messageGroupId);
        result.failed++;
        await this.scheduleRetry(message, error);
        continue;
      }
      await this.markPublished(message);
      result.published++;
    }
    return result;
  }

  /** Tolera que outro publisher já tenha publicado e marcado (lease vencido durante o envio). */
  private async markPublished(message: OutboxMessage): Promise<void> {
    message.markPublished(this.clock.now());
    try {
      await this.uow.run(() => this.outbox.markPublished(message));
    } catch (error) {
      if (error instanceof OptimisticLockError) return;
      throw error;
    }
  }

  private async scheduleRetry(message: OutboxMessage, error: unknown): Promise<void> {
    message.scheduleRetry(this.clock.now(), {
      reason: describeFailure(error),
      jitter: this.config.jitter(),
    });
    await this.uow.run(() => this.outbox.saveRetry(message));
  }
}

/** Motivo curto e seguro para `last_error`: o tipo do erro, nunca a mensagem nem o payload. */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `${error.name}(${code})` : error.name;
  }
  return "UnknownError";
}
