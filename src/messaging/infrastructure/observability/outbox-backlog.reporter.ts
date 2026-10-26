import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { CLOCK } from "../../../shared/application/tokens";
import {
  APP_METRICS,
  type AppMetrics,
  type OutboxBacklog,
} from "../../../shared/infrastructure/metrics/metrics";
import type { Clock } from "../../../shared/kernel";
import {
  OUTBOX_REPOSITORY,
  type OutboxRepository,
} from "../../application/ports/messaging-repositories";

/**
 * Alimenta `outbox_lag_seconds` e `outbox_pending_total` a cada scrape. Roda em todo processo (não
 * só no publisher): é justamente quando o publisher está parado que o lag precisa aparecer.
 */
@Injectable()
export class OutboxBacklogReporter implements OnModuleInit {
  constructor(
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_METRICS) private readonly metrics: AppMetrics,
  ) {}

  onModuleInit(): void {
    this.metrics.bindOutboxBacklog(() => this.read());
  }

  async read(): Promise<OutboxBacklog> {
    const { pending, oldestOccurredAt } = await this.outbox.backlog();
    const lagMs = oldestOccurredAt ? this.clock.now().getTime() - oldestOccurredAt.getTime() : 0;
    return { pending, lagSeconds: Math.max(0, lagMs) / 1000 };
  }
}
