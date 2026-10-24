export const UNIT_OF_WORK = Symbol("UnitOfWork");

export interface UnitOfWorkOptions {
  /** Tempo máximo esperando um lock de linha (padrão 5000 ms). */
  lockTimeoutMs?: number;
  /** Tempo máximo de cada comando SQL (padrão 15000 ms). */
  statementTimeoutMs?: number;
}

/**
 * Fronteira transacional. `run` abre uma transação (READ COMMITTED), executa `fn` e faz COMMIT; se
 * `fn` lançar, faz ROLLBACK e propaga o erro. Chamada aninhada ENTRA na transação em curso.
 */
export interface UnitOfWork {
  run<T>(fn: () => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
