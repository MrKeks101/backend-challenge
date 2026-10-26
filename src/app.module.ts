import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module";
import { HealthModule } from "./health/health.module";
import { ConfigModule } from "./shared/infrastructure/config/config.module";
import { KernelModule } from "./shared/infrastructure/kernel.module";
import { MetricsModule } from "./shared/infrastructure/metrics/metrics.module";
import { CorrelationMiddleware } from "./shared/interfaces/http/correlation";
import { ProblemDetailsFilter } from "./shared/interfaces/http/problem-details.filter";
import { WageringModule } from "./wagering/wagering.module";
import { WalletModule } from "./wallet/wallet.module";

@Module({
  imports: [
    ConfigModule,
    KernelModule,
    MetricsModule,
    AuthModule,
    HealthModule,
    WalletModule,
    WageringModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes({ path: "{*path}", method: RequestMethod.ALL });
  }
}
