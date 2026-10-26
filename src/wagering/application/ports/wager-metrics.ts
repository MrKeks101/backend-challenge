export const WAGER_METRICS = Symbol("WagerMetrics");

export type ProcessingSource = "http" | "sqs" | "reprocessor";

/**
 * Métricas do processamento (RNF-OBS-02). Os use cases e adaptadores só chamam estas operações
 * DEPOIS do commit; a implementação (Prometheus) fica na infraestrutura.
 */
export interface WagerMetrics {
  /** Uma transação chegou a `status` (PROCESSED, REJECTED, PENDING_REFERENCE, FAILED). */
  transactionResolved(status: string, kind: string): void;
  /** `replay`: mesma idempotency key e payload (HTTP/SQS). `inbox`: mensagem SQS já processada. */
  duplicate(source: "replay" | "inbox"): void;
  /** Nova tentativa agendada pelo reprocessador (a transação segue esperando a referência). */
  retry(stage: "reference_wait"): void;
  observeProcessing(source: ProcessingSource, seconds: number): void;
  /** Executa o lock da wallet medindo quanto tempo ele levou para ser concedido. */
  measureWalletLock<T>(lock: () => Promise<T>): Promise<T>;
}
