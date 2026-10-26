import { Inject, Injectable } from "@nestjs/common";
import { APP_METRICS, type AppMetrics } from "../../../shared/infrastructure/metrics/metrics";
import type { ProcessingSource, WagerMetrics } from "../../application/ports/wager-metrics";

@Injectable()
export class PrometheusWagerMetrics implements WagerMetrics {
  constructor(@Inject(APP_METRICS) private readonly metrics: AppMetrics) {}

  transactionResolved(status: string, kind: string): void {
    this.metrics.transactions.inc({ status, kind });
  }

  duplicate(source: "replay" | "inbox"): void {
    this.metrics.duplicates.inc({ source });
  }

  retry(stage: "reference_wait"): void {
    this.metrics.retries.inc({ stage });
  }

  observeProcessing(source: ProcessingSource, seconds: number): void {
    this.metrics.processingDuration.observe({ source }, seconds);
  }

  async measureWalletLock<T>(lock: () => Promise<T>): Promise<T> {
    const stop = this.metrics.walletLockWait.startTimer();
    try {
      return await lock();
    } finally {
      stop();
    }
  }
}
