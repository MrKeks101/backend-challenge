import { Inject, Injectable } from "@nestjs/common";
import { OptimisticLockError } from "../../../shared/infrastructure/persistence/errors";
import { fetchRecords } from "../../../shared/infrastructure/persistence/fetch-records";
import {
  type MikroOrmUnitOfWork,
  UNIT_OF_WORK_IMPL,
} from "../../../shared/infrastructure/persistence/mikro-orm-unit-of-work";
import { insertStatement, selectList } from "../../../shared/infrastructure/persistence/table-def";
import { InvalidArgumentError } from "../../../shared/kernel";
import type {
  InboxRepository,
  OutboxRepository,
} from "../../application/ports/messaging-repositories";
import type { InboxMessage, OutboxMessage } from "../../domain";
import { type InboxRecord, inboxMapper, type OutboxRecord, outboxMapper } from "./messaging.mapper";
import { inboxTable, outboxTable } from "./tables";

const INBOX_COLUMNS = selectList(inboxTable);
const OUTBOX_COLUMNS = selectList(outboxTable);
const INBOX = inboxTable.name;
const OUTBOX = outboxTable.name;

@Injectable()
export class MikroOrmInboxRepository implements InboxRepository {
  constructor(@Inject(UNIT_OF_WORK_IMPL) private readonly uow: MikroOrmUnitOfWork) {}

  async tryReceive(message: InboxMessage): Promise<boolean> {
    const { sql, params } = insertStatement(inboxTable, inboxMapper.toRecord(message), {
      onConflictDoNothing: "(consumer_name, message_id)",
      returning: '"message_id"',
    });
    const rows = await this.uow.current().execute<unknown[]>(sql, params);
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const rows = await fetchRecords<InboxRecord>(
      this.uow.current(),
      inboxTable,
      `SELECT ${INBOX_COLUMNS} FROM ${INBOX} WHERE consumer_name = ? AND message_id = ?`,
      [consumerName, messageId],
    );
    return rows[0] ? inboxMapper.toDomain(rows[0]) : null;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    const rows = await this.uow.current().execute<unknown[]>(
      `UPDATE ${INBOX} SET processed_at = ? WHERE consumer_name = ? AND message_id = ?
           AND processed_at IS NULL RETURNING message_id`,
      [message.processedAt ?? null, message.consumerName, message.messageId],
    );
    if (rows.length !== 1) {
      throw new OptimisticLockError(`inbox message ${message.messageId} not pending`);
    }
  }
}

@Injectable()
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(@Inject(UNIT_OF_WORK_IMPL) private readonly uow: MikroOrmUnitOfWork) {}

  async add(message: OutboxMessage): Promise<void> {
    const { sql, params } = insertStatement(outboxTable, outboxMapper.toRecord(message));
    await this.uow.current().execute(sql, params);
  }

  async findById(id: string): Promise<OutboxMessage | null> {
    const rows = await fetchRecords<OutboxRecord>(
      this.uow.current(),
      outboxTable,
      `SELECT ${OUTBOX_COLUMNS} FROM ${OUTBOX} WHERE id = ?`,
      [id],
    );
    return rows[0] ? outboxMapper.toDomain(rows[0]) : null;
  }

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new InvalidArgumentError("limit must be a positive integer");
    }
    if (!Number.isInteger(leaseMs) || leaseMs < 1) {
      throw new InvalidArgumentError("leaseMs must be a positive integer");
    }
    const em = this.uow.requireTransaction("claimDue");
    const rows = await fetchRecords<OutboxRecord>(
      em,
      outboxTable,
      `UPDATE ${OUTBOX} SET next_attempt_at = ?
       WHERE id IN (
         SELECT id FROM ${OUTBOX} WHERE published_at IS NULL AND next_attempt_at <= ?
         ORDER BY occurred_at, id LIMIT ? FOR UPDATE SKIP LOCKED
       ) RETURNING ${OUTBOX_COLUMNS}`,
      [new Date(now.getTime() + leaseMs), now, limit],
    );
    // RETURNING não garante ordem: reordena para o publisher respeitar a ordem do grupo.
    return rows
      .map((row) => outboxMapper.toDomain(row))
      .sort(
        (a, b) =>
          a.occurredAt.getTime() - b.occurredAt.getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    const rows = await this.uow.current().execute<unknown[]>(
      `UPDATE ${OUTBOX} SET published_at = ?, last_error = NULL WHERE id = ?
           AND published_at IS NULL RETURNING id`,
      [message.publishedAt ?? null, message.id],
    );
    if (rows.length !== 1) {
      throw new OptimisticLockError(`outbox message ${message.id} not pending`);
    }
  }

  async saveRetry(message: OutboxMessage): Promise<void> {
    const rows = await this.uow.current().execute<unknown[]>(
      `UPDATE ${OUTBOX} SET attempts = ?, next_attempt_at = ?, last_error = ?
           WHERE id = ? AND published_at IS NULL RETURNING id`,
      [message.attempts, message.nextAttemptAt, message.lastError ?? null, message.id],
    );
    if (rows.length !== 1) {
      throw new OptimisticLockError(`outbox message ${message.id} not pending`);
    }
  }
}
