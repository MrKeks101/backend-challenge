import { DomainError } from "../../shared/kernel";

export class TransactionNotFoundError extends DomainError {
  readonly code = "TRANSACTION_NOT_FOUND";

  constructor() {
    super("transaction not found");
  }
}

/** A mesma `Idempotency-Key` já foi usada com um payload diferente (nunca é replay, AR-12). */
export class IdempotencyKeyConflictError extends DomainError {
  readonly code = "IDEMPOTENCY_KEY_CONFLICT";

  constructor() {
    super("this idempotency key was already used with a different payload");
  }
}

/** O par `(providerId, externalTransactionId)` já existe sob OUTRA idempotency key. */
export class ExternalTransactionIdConflictError extends DomainError {
  readonly code = "EXTERNAL_TRANSACTION_ID_CONFLICT";

  constructor() {
    super("this provider transaction id was already submitted under a different idempotency key");
  }
}
