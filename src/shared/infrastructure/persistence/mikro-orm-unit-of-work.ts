import { AsyncLocalStorage } from "node:async_hooks";
import { IsolationLevel } from "@mikro-orm/core";
import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import type { UnitOfWork, UnitOfWorkOptions } from "../../application/unit-of-work";
import { type BackoffConfig, backoffDelayMs, InvalidArgumentError } from "../../kernel";
import { classifyError } from "./error-classifier";
import { NoTransactionError } from "./errors";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

interface Ambient {
  em: EntityManager;
}

const CONFLICT_BACKOFF: BackoffConfig = { baseMs: 20, capMs: 200 };
/** Só estes dois SQLSTATEs significam "o PostgreSQL desfez a transação; refazer é seguro". */
const CONFLICT_STATES: ReadonlySet<string> = new Set(["40001", "40P01"]);

const isConflictAbort = (error: unknown): boolean => {
  const { sqlState } = classifyError(error);
  return sqlState !== undefined && CONFLICT_STATES.has(sqlState);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function positiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidArgumentError(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Unit of Work sobre `em.transactional`. O `EntityManager` da transação fica num `AsyncLocalStorage`
 * PRÓPRIO: os repositórios chamam `current()` e nunca recebem `tx` por parâmetro. Todo SQL cru
 * dentro da transação precisa passar por esse `em` (`em.execute`), nunca por `getConnection()`.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly storage = new AsyncLocalStorage<Ambient>();

  constructor(private readonly orm: MikroORM) {}

  async run<T>(fn: () => Promise<T>, options: UnitOfWorkOptions = {}): Promise<T> {
    if (this.storage.getStore()) return fn();

    const lockTimeout = positiveInt(
      options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      "lockTimeoutMs",
    );
    const statementTimeout = positiveInt(
      options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      "statementTimeoutMs",
    );

    const isolationLevel =
      options.isolation === "REPEATABLE READ"
        ? IsolationLevel.REPEATABLE_READ
        : IsolationLevel.READ_COMMITTED;

    const retries = options.retryOnConflict ?? 0;
    if (!Number.isInteger(retries) || retries < 0) {
      throw new InvalidArgumentError("retryOnConflict must be a non-negative integer");
    }

    const attempt = () =>
      this.orm.em.fork().transactional(
        async (em) => {
          // SET LOCAL não aceita parâmetros: os valores são inteiros validados acima.
          await em.execute(`SET LOCAL lock_timeout = ${lockTimeout}`);
          await em.execute(`SET LOCAL statement_timeout = ${statementTimeout}`);
          return this.storage.run({ em: em as EntityManager }, fn);
        },
        { isolationLevel },
      );

    for (let failures = 0; ; failures++) {
      try {
        return await attempt();
      } catch (error) {
        if (failures >= retries || !isConflictAbort(error)) throw error;
        // Jitter para os concorrentes derrubados não colidirem de novo no mesmo instante.
        await sleep(backoffDelayMs(failures + 1, CONFLICT_BACKOFF, 0.5 + Math.random()));
      }
    }
  }

  /** `EntityManager` da transação em curso; fora de uma, um `em` novo (cada comando em autocommit). */
  current(): EntityManager {
    return this.storage.getStore()?.em ?? this.orm.em.fork();
  }

  /** Exige transação: para operações que só fazem sentido nela (`FOR UPDATE`, `SKIP LOCKED`). */
  requireTransaction(operation: string): EntityManager {
    const ambient = this.storage.getStore();
    if (!ambient) throw new NoTransactionError(operation);
    return ambient.em;
  }

  inTransaction(): boolean {
    return this.storage.getStore() !== undefined;
  }
}

export const MIKRO_ORM = Symbol("MikroORM");
export const UNIT_OF_WORK_IMPL = Symbol("MikroOrmUnitOfWork");
