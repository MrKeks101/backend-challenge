import {
  type BeforeApplicationShutdown,
  Inject,
  Module,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { ENV } from "../shared/infrastructure/config/config.module";
import type { Env } from "../shared/infrastructure/config/env";
import {
  OUTBOX_PUBLISHER_CONFIG,
  OutboxPublisher,
  type OutboxPublisherConfig,
} from "./application/outbox-publisher";
import { EVENT_PUBLISHER } from "./application/ports/event-publisher";
import { MessagingPersistenceModule } from "./infrastructure/messaging-persistence.module";
import { OutboxPublisherLoop } from "./infrastructure/outbox-publisher.worker";
import { SqsModule } from "./infrastructure/sqs/sqs.module";
import { SqsEventPublisher } from "./infrastructure/sqs/sqs-event-publisher";

/** Jitter de 0,8 a 1,2 nos backoffs, para publishers derrubados juntos não voltarem juntos. */
const randomJitter = (): number => 0.8 + Math.random() * 0.4;

@Module({
  imports: [DatabaseModule, MessagingPersistenceModule, SqsModule],
  providers: [
    {
      provide: OUTBOX_PUBLISHER_CONFIG,
      inject: [ENV],
      useFactory: (env: Env): OutboxPublisherConfig => ({
        batchSize: env.OUTBOX_BATCH_SIZE,
        leaseMs: env.OUTBOX_LEASE_MS,
        jitter: randomJitter,
      }),
    },
    { provide: EVENT_PUBLISHER, useClass: SqsEventPublisher },
    OutboxPublisher,
  ],
  exports: [OutboxPublisher, EVENT_PUBLISHER, SqsModule],
})
export class MessagingModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private loop: OutboxPublisherLoop | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(OutboxPublisher) private readonly publisher: OutboxPublisher,
  ) {}

  /** Só o papel `publisher` liga o laço; `api` sozinho apenas grava na outbox. */
  onApplicationBootstrap(): void {
    if (!this.env.APP_ROLES.has("publisher")) return;
    this.loop = new OutboxPublisherLoop(
      () => this.publisher.runOnce(),
      this.env.OUTBOX_BATCH_SIZE,
      {
        pollIntervalMs: this.env.OUTBOX_POLL_INTERVAL_MS,
      },
    );
    this.loop.start();
  }

  /** Antes de o banco e o SQS fecharem: termina o ciclo em andamento e para. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.loop?.stop();
  }
}
