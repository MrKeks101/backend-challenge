export const RECONCILIATION_REPORTER = Symbol("ReconciliationReporter");

export interface DivergenceReport {
  walletId: string;
  checkedEntries: number;
  correlationId: string;
}

/** Sinaliza uma divergência (AR-42): log + métrica. Nunca corrige nada. Sem valores financeiros. */
export interface ReconciliationReporter {
  divergenceDetected(report: DivergenceReport): void;
}
