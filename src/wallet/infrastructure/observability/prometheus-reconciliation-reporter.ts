import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_METRICS, type AppMetrics } from "../../../shared/infrastructure/metrics/metrics";
import type {
  DivergenceReport,
  ReconciliationReporter,
} from "../../application/ports/reconciliation-reporter";

@Injectable()
export class PrometheusReconciliationReporter implements ReconciliationReporter {
  private readonly logger = new Logger("Reconciliation");

  constructor(@Inject(APP_METRICS) private readonly metrics: AppMetrics) {}

  divergenceDetected(report: DivergenceReport): void {
    this.metrics.reconciliationDivergences.inc();
    // Só ids e contagem: os valores ficam fora do log (AR-55); a resposta HTTP os traz.
    this.logger.warn({ event: "reconciliation_divergence", ...report });
  }
}
