import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { SqsModule } from "../messaging/infrastructure/sqs/sqs.module";
import { ReadinessController } from "./readiness.controller";
import { READINESS_PROBES, ReadinessService, readinessProbesFactory } from "./readiness.service";

@Module({
  imports: [DatabaseModule, SqsModule],
  controllers: [ReadinessController],
  providers: [
    readinessProbesFactory,
    {
      provide: ReadinessService,
      inject: [READINESS_PROBES],
      useFactory: (probes: ConstructorParameters<typeof ReadinessService>[0]) =>
        new ReadinessService(probes),
    },
  ],
})
export class ReadinessModule {}
