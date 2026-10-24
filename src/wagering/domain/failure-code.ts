/**
 * Taxonomia estável de motivos de rejeição/falha, legível por máquina (RF-FC-*). Nunca renomear nem
 * reaproveitar um código: mudança de significado = código novo.
 */
export enum FailureCode {
  // --- Rejeições de regra de negócio (status REJECTED)
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  AlreadyReversed = "ALREADY_REVERSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  // --- Falhas permanentes de infraestrutura (status FAILED)
  ProcessingRetriesExhausted = "PROCESSING_RETRIES_EXHAUSTED",
  InternalPermanentError = "INTERNAL_PERMANENT_ERROR",
}

/** Códigos válidos para `reject` (status REJECTED). */
export const REJECTION_CODES: ReadonlySet<FailureCode> = new Set([
  FailureCode.InsufficientFunds,
  FailureCode.ReversalWouldOverdraw,
  FailureCode.CurrencyMismatch,
  FailureCode.PlayerWalletMismatch,
  FailureCode.ReferenceNotFound,
  FailureCode.ReferenceNotProcessed,
  FailureCode.ReferenceMismatch,
  FailureCode.ReferenceKindNotAllowed,
  FailureCode.ReferenceAmountMismatch,
  FailureCode.AlreadyReversed,
  FailureCode.ReferenceAlreadyReversed,
]);

/** Códigos válidos para `fail` (status FAILED). */
export const FAILURE_CODES: ReadonlySet<FailureCode> = new Set([
  FailureCode.ProcessingRetriesExhausted,
  FailureCode.InternalPermanentError,
]);

/** O que o provedor deve fazer ao receber o código. */
export enum ProviderAction {
  /** Reenviar o MESMO pedido (mesma key) é seguro e pode resolver. */
  RetrySameKey = "RETRY_SAME_KEY",
  /** Enviar como uma NOVA transação (nova key) quando a condição mudar. */
  ResendAsNewTransaction = "RESEND_AS_NEW_TRANSACTION",
  /** O payload está errado: corrigir antes de enviar de novo. */
  FixPayload = "FIX_PAYLOAD",
  /** Resultado final; não há o que reenviar. */
  GiveUp = "GIVE_UP",
  /** Precisa de tratamento fora de banda (suporte/operação). */
  ManualResolution = "MANUAL_RESOLUTION",
}

const ACTIONS: Readonly<Record<FailureCode, ProviderAction>> = {
  [FailureCode.InsufficientFunds]: ProviderAction.ResendAsNewTransaction,
  [FailureCode.ReversalWouldOverdraw]: ProviderAction.ManualResolution,
  [FailureCode.CurrencyMismatch]: ProviderAction.FixPayload,
  [FailureCode.PlayerWalletMismatch]: ProviderAction.FixPayload,
  [FailureCode.ReferenceNotFound]: ProviderAction.ResendAsNewTransaction,
  [FailureCode.ReferenceNotProcessed]: ProviderAction.GiveUp,
  [FailureCode.ReferenceMismatch]: ProviderAction.FixPayload,
  [FailureCode.ReferenceKindNotAllowed]: ProviderAction.FixPayload,
  [FailureCode.ReferenceAmountMismatch]: ProviderAction.FixPayload,
  [FailureCode.AlreadyReversed]: ProviderAction.GiveUp,
  [FailureCode.ReferenceAlreadyReversed]: ProviderAction.GiveUp,
  [FailureCode.ProcessingRetriesExhausted]: ProviderAction.RetrySameKey,
  [FailureCode.InternalPermanentError]: ProviderAction.ManualResolution,
};

export function providerActionFor(code: FailureCode): ProviderAction {
  return ACTIONS[code];
}
