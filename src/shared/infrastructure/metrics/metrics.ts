import { Counter, Registry } from "prom-client";

/**
 * Registro de métricas da aplicação. O M11 acrescenta as demais métricas e o endpoint `/metrics`;
 * aqui entra só o que o M6 já precisa (RF-API-13).
 */
export class AppMetrics {
  readonly registry = new Registry();

  readonly reconciliationDivergences = new Counter({
    name: "reconciliation_divergences_total",
    help: "Reconciliações que encontraram saldo diferente da soma do ledger",
    registers: [this.registry],
  });
}

export const APP_METRICS = Symbol("AppMetrics");
