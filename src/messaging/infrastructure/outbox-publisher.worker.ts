import { Logger } from "@nestjs/common";
import type { PublishCycleResult } from "../application/outbox-publisher";

export interface WorkerOptions {
  /** Pausa quando um ciclo não encontra trabalho (ou falha). */
  pollIntervalMs: number;
  /** Teto da pausa depois de falhas seguidas (backoff linear até aqui). */
  maxErrorPauseMs?: number;
}

/**
 * Laço do publisher: roda ciclos até `stop()`. Se o ciclo veio cheio, repete na hora (há mais
 * trabalho); senão dorme. Um erro (banco ou SQS fora) nunca derruba o laço: registra e tenta de
 * novo com pausa crescente. `stop()` interrompe a pausa e espera o ciclo em andamento terminar,
 * para o processo encerrar sem largar uma publicação pela metade.
 */
export class OutboxPublisherLoop {
  private readonly logger = new Logger("OutboxPublisher");
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly cycle: () => Promise<PublishCycleResult>,
    private readonly batchSize: number,
    private readonly options: WorkerOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    let consecutiveErrors = 0;
    while (this.running) {
      let pause = this.options.pollIntervalMs;
      try {
        const result = await this.cycle();
        consecutiveErrors = 0;
        if (result.claimed >= this.batchSize) pause = 0; // veio cheio: há mais por publicar
        if (result.failed > 0) {
          this.logger.warn({ event: "outbox_publish_failed", failed: result.failed });
        }
      } catch (error) {
        consecutiveErrors++;
        pause = Math.min(
          this.options.pollIntervalMs * (consecutiveErrors + 1),
          this.options.maxErrorPauseMs ?? 10_000,
        );
        // Só o tipo do erro: mensagens de driver podem carregar dados da linha.
        this.logger.error({
          event: "outbox_cycle_error",
          error: error instanceof Error ? error.name : typeof error,
          consecutiveErrors,
        });
      }
      if (pause > 0 && this.running) await this.sleep(pause);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}
