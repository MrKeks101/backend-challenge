/** Escrita condicional não afetou nenhuma linha: outro processo alterou o registro (versão/estado). Transitório: recarregar e tentar de novo. */
export class OptimisticLockError extends Error {
  readonly code = "OPTIMISTIC_LOCK";
  constructor(what: string) {
    super(`concurrent modification detected: ${what}`);
    this.name = "OptimisticLockError";
  }
}

/** Operação que depende de transação (p.ex. `FOR UPDATE`) chamada fora de uma. Erro de programação. */
export class NoTransactionError extends Error {
  readonly code = "NO_TRANSACTION";
  constructor(operation: string) {
    super(`${operation} requires an active transaction`);
    this.name = "NoTransactionError";
  }
}
