import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { MessagingPersistenceModule } from "../messaging/infrastructure/messaging-persistence.module";
import { ENV } from "../shared/infrastructure/config/config.module";
import type { Env } from "../shared/infrastructure/config/env";
import { OPENING_RECORDER } from "../wallet/application/ports/opening-recorder";
import { WalletPersistenceModule } from "../wallet/infrastructure/wallet-persistence.module";
import {
  PendingReferenceReprocessor,
  REPROCESSOR_CONFIG,
  type ReprocessorConfig,
} from "./application/pending-reference-reprocessor";
import {
  PENDING_REFERENCE_SETTINGS,
  type PendingReferenceSettings,
} from "./application/pending-reference-settings";
import { WAGER_METRICS } from "./application/ports/wager-metrics";
import { ProcessWagerTransactionUseCase } from "./application/process-wager-transaction.use-case";
import { ReprocessPendingTransactionUseCase } from "./application/reprocess-pending-transaction.use-case";
import { WagerOutcomeApplier } from "./application/wager-outcome-applier";
import { GetTransactionQuery } from "./application/wager-queries";
import { WageringOpeningRecorder } from "./application/wagering-opening-recorder";
import { validatePendingReferenceConfig } from "./domain";
import { PrometheusWagerMetrics } from "./infrastructure/observability/prometheus-wager-metrics";
import { WageringPersistenceModule } from "./infrastructure/wagering-persistence.module";
import { WageringController } from "./interfaces/http/wagering.controller";

/** Jitter de 0,8 a 1,2 no backoff da espera pela referência. */
const randomJitter = (): number => 0.8 + Math.random() * 0.4;

/** Casos de uso e API do contexto de Wagering. */
@Module({
  imports: [
    DatabaseModule,
    WageringPersistenceModule,
    WalletPersistenceModule,
    MessagingPersistenceModule,
  ],
  controllers: [WageringController],
  providers: [
    {
      provide: PENDING_REFERENCE_SETTINGS,
      inject: [ENV],
      useFactory: (env: Env): PendingReferenceSettings => {
        const policy = {
          maxAttempts: env.PENDING_REFERENCE_MAX_ATTEMPTS,
          ttlMs: env.PENDING_REFERENCE_TTL_MS,
          baseMs: env.PENDING_REFERENCE_BACKOFF_BASE_MS,
          capMs: env.PENDING_REFERENCE_BACKOFF_CAP_MS,
        };
        validatePendingReferenceConfig(policy); // falha na subida, não na primeira pendência
        return { policy, jitter: randomJitter };
      },
    },
    {
      provide: REPROCESSOR_CONFIG,
      inject: [ENV],
      useFactory: (env: Env): ReprocessorConfig => ({
        batchSize: env.REPROCESSOR_BATCH_SIZE,
        leaseMs: env.REPROCESSOR_LEASE_MS,
      }),
    },
    { provide: WAGER_METRICS, useClass: PrometheusWagerMetrics },
    WagerOutcomeApplier,
    ProcessWagerTransactionUseCase,
    ReprocessPendingTransactionUseCase,
    PendingReferenceReprocessor,
    GetTransactionQuery,
    { provide: OPENING_RECORDER, useClass: WageringOpeningRecorder },
  ],
  exports: [
    WAGER_METRICS,
    OPENING_RECORDER,
    WagerOutcomeApplier,
    ProcessWagerTransactionUseCase,
    PendingReferenceReprocessor,
  ],
})
export class WageringModule {}
