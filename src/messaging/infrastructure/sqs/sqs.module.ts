import { SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { ENV } from "../../../shared/infrastructure/config/config.module";
import type { Env } from "../../../shared/infrastructure/config/env";
import { ensureQueues, type QueueUrls, queueNames } from "./ensure-queues";

export const SQS_CLIENT = Symbol("SqsClient");

/** Cliente do SDK com timeouts: um SQS que não responde não pode travar o processo para sempre. */
export function createSqsClient(env: Env): SQSClient {
  return new SQSClient({
    region: env.AWS_REGION,
    ...(env.SQS_ENDPOINT ? { endpoint: env.SQS_ENDPOINT } : {}),
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 2_000, requestTimeout: 10_000 },
  });
}

/**
 * Garante as filas uma vez por processo (memoiza o sucesso) e entrega as URLs. Uma falha NÃO é
 * memoizada: a próxima chamada tenta de novo, então o processo se recupera quando o SQS volta.
 */
@Injectable()
export class QueueRegistry {
  private pending: Promise<QueueUrls> | undefined;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(ENV) private readonly env: Env,
  ) {}

  ensure(): Promise<QueueUrls> {
    if (!this.pending) {
      this.pending = ensureQueues(this.sqs, queueNames(this.env.SQS_QUEUE_PREFIX)).catch(
        (error: unknown) => {
          this.pending = undefined;
          throw error;
        },
      );
    }
    return this.pending;
  }
}

@Module({
  providers: [
    { provide: SQS_CLIENT, inject: [ENV], useFactory: (env: Env) => createSqsClient(env) },
    QueueRegistry,
  ],
  exports: [SQS_CLIENT, QueueRegistry],
})
export class SqsModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
