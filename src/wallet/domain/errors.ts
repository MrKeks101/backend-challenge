import { DomainError } from "../../shared/kernel";

/** Débito acima do saldo disponível. */
export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";

  constructor() {
    super("insufficient funds for this debit");
  }
}

/** Violação de regra da Wallet (abertura com saldo negativo, movimento não positivo...). */
export class InvalidWalletError extends DomainError {
  readonly code = "INVALID_WALLET";
}

/** Lançamento inválido ou com aritmética que não fecha. */
export class InvalidLedgerEntryError extends DomainError {
  readonly code = "INVALID_LEDGER_ENTRY";
}
