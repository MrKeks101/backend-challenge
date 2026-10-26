import { DomainError } from "../../shared/kernel";

export class WalletNotFoundError extends DomainError {
  readonly code = "WALLET_NOT_FOUND";

  constructor() {
    super("wallet not found");
  }
}

/** Já existe wallet para este `(playerId, currency)` (AR-15). */
export class WalletAlreadyExistsError extends DomainError {
  readonly code = "WALLET_ALREADY_EXISTS";

  constructor() {
    super("a wallet already exists for this player and currency");
  }
}

export class InvalidCursorError extends DomainError {
  readonly code = "INVALID_CURSOR";

  constructor() {
    super("cursor is invalid for this wallet");
  }
}
