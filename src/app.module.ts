import { Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module";
import { ConfigModule } from "./shared/infrastructure/config/config.module";

@Module({ imports: [ConfigModule, HealthModule] })
export class AppModule {}
