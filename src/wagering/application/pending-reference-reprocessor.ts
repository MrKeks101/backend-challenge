import { Inject, Injectable, Logger } from "@nestjs/common";
import { CLOCK } from "../../shared/application/tokens";
import { UNIT_OF_WORK, type UnitOfWork } from "../../shared/application/unit-of-work";
import { classifyError } from "../../shared/infrastructure/persistence/error-classifier";
import type { Clock } from "../../shared/kernel";
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from "./ports/wager-transaction-repository";
import {
  ReprocessPendingTransactionUseCase,
  type ReprocessResult,
} from "./reprocess-pending-transaction.use-case";

export const REPROCESSOR_CONFIG = Symbol("ReprocessorConfig");

export interface ReprocessorConfig {
  /** Máximo de pendências reivindicadas por ciclo. */
  batchSize: number;
  /** Lease: se o reprocessador morrer, a pendência volta a ficar elegível depois disso. */
  leaseMs: number;
}

export interface ReprocessCycleResult {
  claimed: number;
  /** Falhas inesperadas (banco fora etc.): o lease expira e a pendência é tentada de novo. */
  failed: number;
  results: Record<ReprocessResult, number>;
}

const emptyResults = (): Record<ReprocessResult, number> => ({
  NOOP: 0,
  PROCESSED: 0,
  REJECTED: 0,
  STILL_PENDING: 0,
  GAVE_UP: 0,
});

/**
 * Um ciclo do reprocessador (ARCHITECTURE §10): (1) reivindica pendências vencidas numa transação
 * CURTA (`SKIP LOCKED` + lease), sem segurar lock durante o reprocessamento; (2) reprocessa cada
 * uma numa transação própria. Reprocessadores concorrentes recebem lotes disjuntos, e a conferência
 * de estado sob o lock da wallet impede aplicar duas vezes mesmo se o lease vencer no meio.
 */
@Injectable()
export class PendingReferenceReprocessor {
  private readonly logger = new Logger("PendingReferenceReprocessor");

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    @Inject(ReprocessPendingTransactionUseCase)
    private readonly reprocess: ReprocessPendingTransactionUseCase,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(REPROCESSOR_CONFIG) private readonly config: ReprocessorConfig,
  ) {}

  async runOnce(): Promise<ReprocessCycleResult> {
    const claimed = await this.uow.run(() =>
      this.transactions.claimDue(this.clock.now(), this.config.batchSize, this.config.leaseMs),
    );

    const result: ReprocessCycleResult = {
      claimed: claimed.length,
      failed: 0,
      results: emptyResults(),
    };
    for (const transaction of claimed) {
      try {
        const outcome = await this.reprocess.execute(transaction.id, {
          correlationId: `reprocessor:${transaction.id}`,
        });
        result.results[outcome]++;
      } catch (error) {
        result.failed++;
        // Sem retry aqui: o lease vence e o próximo ciclo (ou outra instância) tenta de novo.
        this.logger.warn({
          event: "reprocess_failed",
          transactionId: transaction.id,
          reason: classifyError(error).reason,
        });
      }
    }
    return result;
  }
}
