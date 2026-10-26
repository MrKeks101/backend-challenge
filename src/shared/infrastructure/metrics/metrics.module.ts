import { Global, Module } from "@nestjs/common";
import { APP_METRICS, AppMetrics } from "./metrics";

@Global()
@Module({
  providers: [{ provide: APP_METRICS, useFactory: () => new AppMetrics({ processMetrics: true }) }],
  exports: [APP_METRICS],
})
export class MetricsModule {}
