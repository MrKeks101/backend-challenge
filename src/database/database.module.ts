import type { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { UNIT_OF_WORK } from "../shared/application/unit-of-work";
import { ENV } from "../shared/infrastructure/config/config.module";
import type { Env } from "../shared/infrastructure/config/env";
import { APP_METRICS, type AppMetrics } from "../shared/infrastructure/metrics/metrics";
import {
  MIKRO_ORM,
  MikroOrmUnitOfWork,
  UNIT_OF_WORK_IMPL,
} from "../shared/infrastructure/persistence/mikro-orm-unit-of-work";
import { createOrm } from "./orm";

/** ORM + Unit of Work. Os módulos de persistência de cada contexto importam este. */
@Module({
  providers: [
    { provide: MIKRO_ORM, inject: [ENV], useFactory: (env: Env) => createOrm(env.DATABASE_URL) },
    {
      provide: UNIT_OF_WORK_IMPL,
      inject: [MIKRO_ORM, APP_METRICS],
      useFactory: (orm: MikroORM, metrics: AppMetrics) =>
        new MikroOrmUnitOfWork(orm, {
          lockConflict: (reason) => metrics.lockConflicts.inc({ reason }),
        }),
    },
    { provide: UNIT_OF_WORK, useExisting: UNIT_OF_WORK_IMPL },
  ],
  exports: [MIKRO_ORM, UNIT_OF_WORK, UNIT_OF_WORK_IMPL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MIKRO_ORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}
