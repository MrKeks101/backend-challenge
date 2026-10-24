export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. No fluxo síncrono só existe dentro da transação SQL. */
  Pending = "PENDING",
  /** Aguardando a transação referenciada chegar. */
  PendingReference = "PENDING_REFERENCE",
  /** Aplicada (terminal). */
  Processed = "PROCESSED",
  /** Violação de regra de negócio (terminal). */
  Rejected = "REJECTED",
  /** Erro permanente de infraestrutura (terminal, auditável). */
  Failed = "FAILED",
}
