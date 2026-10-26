import { Controller, Get, Header, Inject } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { APP_METRICS, type AppMetrics } from "../shared/infrastructure/metrics/metrics";

/** Endpoint de scrape do Prometheus. Público como os health checks (AR-36); não expõe valores. */
@Public()
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(APP_METRICS) private readonly metrics: AppMetrics) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  render(): Promise<string> {
    return this.metrics.render();
  }
}
