import { DomainError } from "../../shared/kernel";

/** Transação de aposta malformada ou violando uma regra estrutural do seu `kind`. */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = "INVALID_WAGER_TRANSACTION";
}
