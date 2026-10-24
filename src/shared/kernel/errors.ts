/**
 * Erros de domínio. Cada classe carrega um `code` estável e legível por máquina, usado depois pelo
 * mapeamento HTTP e pelo classificador de erros. As mensagens NÃO repetem valores financeiros
 * (AR-55): descrevem o motivo, não o dado recebido.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada monetária malformada (formato, tipo, moeda). */
export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";
}

/** Resultado ou entrada fora do intervalo representável (numeric(19,2)). */
export class MoneyOverflowError extends DomainError {
  readonly code = "MONEY_OVERFLOW";
}

/** Operação entre moedas diferentes. */
export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super(`currency mismatch: ${left} vs ${right}`);
  }
}

/** Transição de estado inválida (p.ex. mexer em transação já terminal). É erro de programação. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";

  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`invalid transaction state transition: ${from} -> ${to}`);
  }
}
