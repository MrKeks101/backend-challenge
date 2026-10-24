import { Inject, Injectable } from "@nestjs/common";
import { OptimisticLockError } from "../../../shared/infrastructure/persistence/errors";
import { fetchRecords } from "../../../shared/infrastructure/persistence/fetch-records";
import {
  type MikroOrmUnitOfWork,
  UNIT_OF_WORK_IMPL,
} from "../../../shared/infrastructure/persistence/mikro-orm-unit-of-work";
import { insertStatement, selectList } from "../../../shared/infrastructure/persistence/table-def";
import { InvalidArgumentError } from "../../../shared/kernel";
import type { WagerTransactionRepository } from "../../application/ports/wager-transaction-repository";
import type { WagerTransaction } from "../../domain";
import { wagerTransactionsTable } from "./tables";
import { type WagerTransactionRecord, wagerTransactionMapper } from "./wager-transaction.mapper";

const COLUMNS = selectList(wagerTransactionsTable);
const T = wagerTransactionsTable.name;

@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(@Inject(UNIT_OF_WORK_IMPL) private readonly uow: MikroOrmUnitOfWork) {}

  async claim(transaction: WagerTransaction): Promise<boolean> {
    const { sql, params } = insertStatement(
      wagerTransactionsTable,
      wagerTransactionMapper.toRecord(transaction, transaction.createdAt),
      { onConflictDoNothing: "", returning: '"id"' },
    );
    const rows = await this.uow.current().execute<unknown[]>(sql, params);
    return rows.length === 1;
  }

  findById(id: string): Promise<WagerTransaction | null> {
    return this.one("id = ?", [id]);
  }

  findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    return this.one("idempotency_key = ?", [key]);
  }

  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return this.one("provider_id = ? AND external_transaction_id = ?", [
      providerId,
      externalTransactionId,
    ]);
  }

  async update(transaction: WagerTransaction, at: Date): Promise<void> {
    const r = wagerTransactionMapper.toRecord(transaction, at);
    const rows = await this.uow.current().execute<unknown[]>(
      `UPDATE ${T} SET status = ?, failure_code = ?, reference_transaction_id = ?, observed_balance = ?,
         attempts = ?, next_attempt_at = ?, processed_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('PENDING', 'PENDING_REFERENCE') RETURNING id`,
      [
        r.status,
        r.failureCode,
        r.referenceTransactionId,
        r.observedBalance,
        r.attempts,
        r.nextAttemptAt,
        r.processedAt,
        r.updatedAt,
        r.id,
      ],
    );
    if (rows.length !== 1) {
      throw new OptimisticLockError(`transaction ${transaction.id} is already terminal or missing`);
    }
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const rows = await this.uow.current().execute<unknown[]>(
      `SELECT 1 FROM ${T} WHERE reference_transaction_id = ? AND status = 'PROCESSED'
         AND kind IN ('REFUND', 'ROLLBACK') LIMIT 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<WagerTransaction[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new InvalidArgumentError("limit must be a positive integer");
    }
    if (!Number.isInteger(leaseMs) || leaseMs < 1) {
      throw new InvalidArgumentError("leaseMs must be a positive integer");
    }
    const em = this.uow.requireTransaction("claimDue");
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows = await fetchRecords<WagerTransactionRecord>(
      em,
      wagerTransactionsTable,
      `UPDATE ${T} SET next_attempt_at = ?, updated_at = ?
       WHERE id IN (
         SELECT id FROM ${T} WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ?
         ORDER BY next_attempt_at, id LIMIT ? FOR NO KEY UPDATE SKIP LOCKED
       ) RETURNING ${COLUMNS}`,
      [leaseUntil, now, now, limit],
    );
    return rows.map((row) => wagerTransactionMapper.toDomain(row));
  }

  async wakeDependents(
    providerId: string,
    externalTransactionId: string,
    now: Date,
  ): Promise<number> {
    const rows = await this.uow.current().execute<unknown[]>(
      `UPDATE ${T} SET next_attempt_at = ?, updated_at = ?
       WHERE provider_id = ? AND reference_external_transaction_id = ?
         AND status = 'PENDING_REFERENCE' AND next_attempt_at > ? RETURNING id`,
      [now, now, providerId, externalTransactionId, now],
    );
    return rows.length;
  }

  private async one(where: string, params: unknown[]): Promise<WagerTransaction | null> {
    const rows = await fetchRecords<WagerTransactionRecord>(
      this.uow.current(),
      wagerTransactionsTable,
      `SELECT ${COLUMNS} FROM ${T} WHERE ${where}`,
      params,
    );
    return rows[0] ? wagerTransactionMapper.toDomain(rows[0]) : null;
  }
}
