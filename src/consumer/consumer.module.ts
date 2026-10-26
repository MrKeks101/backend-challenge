import type { SQSClient } from "@aws-sdk/client-sqs";
import {
  type BeforeApplicationShutdown,
  Inject,
  Module,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { MESSAGE_HANDLER } from "../messaging/application/ports/message-handler";
import { MessagingPersistenceModule } from "../messaging/infrastructure/messaging-persistence.module";
import { QueueRegistry, SQS_CLIENT, SqsModule } from "../messaging/infrastructure/sqs/sqs.module";
import {
  SqsConsumer,
  visibilityBackoffSeconds,
} from "../messaging/infrastructure/sqs/sqs-consumer";
import { ENV } from "../shared/infrastructure/config/config.module";
import type { Env } from "../shared/infrastructure/config/env";
import { APP_METRICS, type AppMetrics } from "../shared/infrastructure/metrics/metrics";
import { WagerMessageHandler } from "../wagering/interfaces/sqs/wager-message.handler";
import { WageringModule } from "../wagering/wagering.module";

const SQS_CONSUMER = Symbol("SqsConsumer");

/** Jitter de 0,8 a 1,2 na visibilidade, para mensagens que falharam juntas não voltarem juntas. */
const randomJitter = (): number => 0.8 + Math.random() * 0.4;

/**
 * Papel `consumer`: liga o consumidor da fila de entrada ao caso de uso de Wagering. O laço só
 * inicia se `APP_ROLES` incluir `consumer`, e para antes de o banco e o SQS fecharem.
 */
@Module({
  imports: [DatabaseModule, MessagingPersistenceModule, SqsModule, WageringModule],
  providers: [
    WagerMessageHandler,
    { provide: MESSAGE_HANDLER, useExisting: WagerMessageHandler },
    {
      provide: SQS_CONSUMER,
      inject: [SQS_CLIENT, QueueRegistry, MESSAGE_HANDLER, ENV, APP_METRICS],
      useFactory: (
        sqs: SQSClient,
        queues: QueueRegistry,
        handler: WagerMessageHandler,
        env: Env,
        metrics: AppMetrics,
      ) =>
        new SqsConsumer(
          sqs,
          queues,
          handler,
          {
            pollers: env.CONSUMER_POLLERS,
            batchSize: env.CONSUMER_BATCH_SIZE,
            waitSeconds: env.CONSUMER_WAIT_SECONDS,
            shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
            retryDelaySeconds: (receiveCount) =>
              visibilityBackoffSeconds(
                receiveCount,
                env.CONSUMER_RETRY_BASE_SECONDS,
                randomJitter(),
              ),
          },
          metrics,
        ),
    },
  ],
  exports: [MESSAGE_HANDLER],
})
export class ConsumerModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(SQS_CONSUMER) private readonly consumer: SqsConsumer,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.APP_ROLES.has("consumer")) this.consumer.start();
  }

  /** SIGTERM: para de receber, espera as mensagens em andamento e devolve as que não terminaram. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
  }
}
