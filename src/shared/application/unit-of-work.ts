export const UNIT_OF_WORK = Symbol("UnitOfWork");

export interface UnitOfWorkOptions {
  /**
   * Repetições EXTRAS (além da 1ª execução) quando a transação é desfeita por deadlock (`40P01`)
   * ou falha de serialização (`40001`) — nenhum outro erro é repetido. Padrão 0. Cada repetição
   * roda `fn` de novo numa transação nova: `fn` não pode reaproveitar objetos já mutados.
   */
  retryOnConflict?: number;
  /** Nível de isolamento da transação (padrão `READ COMMITTED`). `REPEATABLE READ` dá um snapshot único. */
  isolation?: "READ COMMITTED" | "REPEATABLE READ";
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
