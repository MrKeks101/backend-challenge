import type { WagerTransaction } from "../../domain";

export const WAGER_TRANSACTION_REPOSITORY = Symbol("WagerTransactionRepository");

export interface WagerTransactionRepository {
  /**
   * Reivindica a idempotência: `INSERT … ON CONFLICT DO NOTHING`. `true` = esta chamada criou a
   * transação; `false` = já existia (mesma key ou mesmo `(provider, externalId)`), nada gravado.
   * Sob concorrência, a 2ª espera o COMMIT da 1ª e então devolve `false`.
   */
  claim(transaction: WagerTransaction): Promise<boolean>;
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  /**
   * Persiste a evolução de estado de uma transação NÃO terminal. O banco só aceita a escrita se a
   * linha ainda estiver `PENDING`/`PENDING_REFERENCE`; senão lança `OptimisticLockError`.
   */
  update(transaction: WagerTransaction, at: Date): Promise<void>;
  /** Existe REFUND/ROLLBACK `PROCESSED` apontando para esta transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /**
   * Reivindica até `limit` transações `PENDING_REFERENCE` vencidas (`FOR UPDATE SKIP LOCKED`),
   * empurrando `next_attempt_at` para `now + leaseMs` (lease). Exige transação.
   */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<WagerTransaction[]>;
  /** Torna vencidas as pendências que aguardam `(providerId, externalTransactionId)`. */
  wakeDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
}
