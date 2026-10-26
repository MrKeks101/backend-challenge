import {
  type BeforeApplicationShutdown,
  Inject,
  Module,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { ENV } from "../shared/infrastructure/config/config.module";
import type { Env } from "../shared/infrastructure/config/env";
import { PollingLoop } from "../shared/infrastructure/polling-loop";
import { PendingReferenceReprocessor } from "../wagering/application/pending-reference-reprocessor";
import { WageringModule } from "../wagering/wagering.module";

/**
 * Papel `reprocessor`: liga o laço que reavalia transações `PENDING_REFERENCE`. O laço só inicia se
 * `APP_ROLES` incluir `reprocessor`, e para (terminando o ciclo em andamento) antes de o banco fechar.
 */
@Module({ imports: [WageringModule] })
export class ReprocessorModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private loop: PollingLoop | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PendingReferenceReprocessor) private readonly reprocessor: PendingReferenceReprocessor,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.APP_ROLES.has("reprocessor")) return;
    this.loop = new PollingLoop(() => this.reprocessor.runOnce(), this.env.REPROCESSOR_BATCH_SIZE, {
      pollIntervalMs: this.env.REPROCESSOR_POLL_INTERVAL_MS,
      name: "PendingReferenceReprocessor",
    });
    this.loop.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop?.stop();
  }
}
