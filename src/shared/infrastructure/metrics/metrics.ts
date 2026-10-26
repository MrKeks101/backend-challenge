import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

/** Fila de saída ainda não publicada: quantas mensagens e há quantos segundos a mais antiga espera. */
export interface OutboxBacklog {
  pending: number;
  lagSeconds: number;
}

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const LOCK_WAIT_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5];

/**
 * Registro de métricas da aplicação (RNF-OBS-02). Os contadores são incrementados DEPOIS do commit:
 * uma transação desfeita por deadlock e repetida não conta duas vezes.
 */
export class AppMetrics {
  readonly registry = new Registry();
  private backlogProvider: (() => Promise<OutboxBacklog>) | undefined;

  /** Transações que chegaram a um status (uma pendência resolvida depois conta de novo, no novo status). */
  readonly transactions = new Counter({
    name: "wager_transactions_total",
    help: "Transações que chegaram a um status, por status e tipo",
    labelNames: ["status", "kind"],
    registers: [this.registry],
  });

  readonly duplicates = new Counter({
    name: "wager_duplicates_total",
    help: "Duplicatas detectadas: replay de idempotência (replay) ou mensagem já vista na inbox (inbox)",
    labelNames: ["source"],
    registers: [this.registry],
  });

  readonly retries = new Counter({
    name: "wager_retries_total",
    help: "Novas tentativas agendadas: reentrega SQS, espera pela referência",
    labelNames: ["stage"],
    registers: [this.registry],
  });

  readonly dlqMessages = new Counter({
    name: "dlq_messages_total",
    help: "Mensagens enviadas à DLQ, por motivo",
    labelNames: ["reason"],
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: "lock_conflicts_total",
    help: "Conflitos de concorrência que desfizeram uma transação (deadlock, serialização, lock timeout, lock otimista)",
    labelNames: ["reason"],
    registers: [this.registry],
  });

  readonly walletLockWait = new Histogram({
    name: "wallet_lock_wait_seconds",
    help: "Tempo esperando o lock de linha da wallet (SELECT … FOR NO KEY UPDATE)",
    buckets: LOCK_WAIT_BUCKETS,
    registers: [this.registry],
  });

  readonly processingDuration = new Histogram({
    name: "wager_processing_duration_seconds",
    help: "Latência de processamento de uma transação, por origem (http, sqs, reprocessor)",
    labelNames: ["source"],
    buckets: DURATION_BUCKETS,
    registers: [this.registry],
  });

  readonly outboxLagSeconds = new Gauge({
    name: "outbox_lag_seconds",
    help: "Idade da mensagem mais antiga da outbox ainda não publicada (0 se não há nenhuma)",
    registers: [this.registry],
  });

  readonly outboxPending = new Gauge({
    name: "outbox_pending_total",
    help: "Mensagens da outbox ainda não publicadas",
    registers: [this.registry],
  });

  readonly reconciliationDivergences = new Counter({
    name: "reconciliation_divergences_total",
    help: "Reconciliações que encontraram saldo diferente da soma do ledger",
    registers: [this.registry],
  });

  /** `processMetrics`: métricas padrão do processo (CPU, memória, event loop); desligadas nos testes. */
  constructor(options: { processMetrics?: boolean } = {}) {
    if (options.processMetrics) collectDefaultMetrics({ register: this.registry });
  }

  /** Quem sabe consultar a outbox (módulo de messaging) se registra aqui. */
  bindOutboxBacklog(provider: () => Promise<OutboxBacklog>): void {
    this.backlogProvider = provider;
  }

  /**
   * Corpo do `/metrics`. O backlog da outbox é lido do banco no momento do scrape (uma consulta),
   * então o lag continua subindo mesmo com o publisher parado. Se o banco falhar, as demais métricas
   * saem do mesmo jeito e as gauges da outbox ficam com o último valor.
   */
  async render(): Promise<string> {
    if (this.backlogProvider) {
      try {
        const backlog = await this.backlogProvider();
        this.outboxPending.set(backlog.pending);
        this.outboxLagSeconds.set(backlog.lagSeconds);
      } catch {
        // observabilidade nunca derruba o scrape
      }
    }
    return this.registry.metrics();
  }
}

export const APP_METRICS = Symbol("AppMetrics");
