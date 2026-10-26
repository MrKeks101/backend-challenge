import { AppMetrics } from "../../src/shared/infrastructure/metrics/metrics";
import { PrometheusWagerMetrics } from "../../src/wagering/infrastructure/observability/prometheus-wager-metrics";

/** Métricas reais (Prometheus) sobre um registro novo: cada teste lê o que elas contaram. */
export function makeMetrics() {
  const app = new AppMetrics();
  return { app, wager: new PrometheusWagerMetrics(app) };
}

type Labels = Record<string, string>;

/**
 * Valor da série `name` cujos rótulos contêm `labels` (soma se mais de uma casar). Para histogramas
 * use o sufixo: `wager_processing_duration_seconds_count`. 0 se a série ainda não existe.
 */
export async function metricValue(app: AppMetrics, name: string, labels: Labels = {}) {
  const base = name.replace(/_(count|sum|bucket)$/, "");
  const metric = app.registry.getSingleMetric(base) ?? app.registry.getSingleMetric(name);
  if (!metric) throw new Error(`metric ${name} is not registered`);
  const { values } = await metric.get();
  return values
    .filter((v) => ((v as { metricName?: string }).metricName ?? base) === name)
    .filter((v) => Object.entries(labels).every(([key, value]) => v.labels[key] === value))
    .reduce((sum, v) => sum + v.value, 0);
}
