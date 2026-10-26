import { Logger } from "@nestjs/common";

/** O que o laço precisa saber de um ciclo para decidir a pausa. */
export interface CycleStats {
  /** Itens reivindicados neste ciclo. */
  claimed: number;
  /** Itens que falharam neste ciclo (só para log). */
  failed: number;
}

export interface PollingOptions {
  /** Pausa quando um ciclo não encontra trabalho (ou falha). */
  pollIntervalMs: number;
  /** Teto da pausa depois de falhas seguidas (backoff linear até aqui). */
  maxErrorPauseMs?: number;
  /** Nome do worker nos logs. */
  name?: string;
}

/**
 * Laço de worker (publisher da outbox, reprocessador de pendências): roda ciclos até `stop()`. Se o
 * ciclo veio cheio, repete na hora (há mais trabalho); senão dorme. Um erro (banco ou SQS fora)
 * nunca derruba o laço: registra e tenta de novo com pausa crescente. `stop()` interrompe a pausa
 * e espera o ciclo em andamento terminar, para o processo encerrar sem largar trabalho pela metade.
 */
export class PollingLoop {
  private readonly logger: Logger;
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly cycle: () => Promise<CycleStats>,
    private readonly batchSize: number,
    private readonly options: PollingOptions,
  ) {
    this.logger = new Logger(options.name ?? "PollingLoop");
  }

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
        if (result.claimed >= this.batchSize) pause = 0; // veio cheio: há mais por fazer
        if (result.failed > 0) {
          this.logger.warn({ event: "cycle_items_failed", failed: result.failed });
        }
      } catch (error) {
        consecutiveErrors++;
        pause = Math.min(
          this.options.pollIntervalMs * (consecutiveErrors + 1),
          this.options.maxErrorPauseMs ?? 10_000,
        );
        // Só o tipo do erro: mensagens de driver podem carregar dados da linha.
        this.logger.error({
          event: "cycle_error",
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
