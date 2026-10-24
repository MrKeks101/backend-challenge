import { Inject, Injectable } from "@nestjs/common";
import { OptimisticLockError } from "../../../shared/infrastructure/persistence/errors";
import { fetchRecords } from "../../../shared/infrastructure/persistence/fetch-records";
import {
  type MikroOrmUnitOfWork,
  UNIT_OF_WORK_IMPL,
} from "../../../shared/infrastructure/persistence/mikro-orm-unit-of-work";
import { insertStatement, selectList } from "../../../shared/infrastructure/persistence/table-def";
import type { WalletRepository } from "../../application/ports/wallet-repositories";
import type { Wallet } from "../../domain";
import { walletsTable } from "./tables";
import { type WalletRecord, walletMapper } from "./wallet.mapper";

const COLUMNS = selectList(walletsTable);
const T = walletsTable.name;

@Injectable()
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(@Inject(UNIT_OF_WORK_IMPL) private readonly uow: MikroOrmUnitOfWork) {}

  async insert(wallet: Wallet): Promise<boolean> {
    const { sql, params } = insertStatement(walletsTable, walletMapper.toRecord(wallet), {
      onConflictDoNothing: "(player_id, currency)",
      returning: '"id"',
    });
    const rows = await this.uow.current().execute<unknown[]>(sql, params);
    return rows.length === 1;
  }

  findById(id: string): Promise<Wallet | null> {
    return this.one(`SELECT ${COLUMNS} FROM ${T} WHERE id = ?`, [id]);
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const em = this.uow.requireTransaction("findByIdForUpdate");
    const rows = await fetchRecords<WalletRecord>(
      em,
      walletsTable,
      `SELECT ${COLUMNS} FROM ${T} WHERE id = ? FOR NO KEY UPDATE`,
      [id],
    );
    return rows[0] ? walletMapper.toDomain(rows[0]) : null;
  }

  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    return this.one(`SELECT ${COLUMNS} FROM ${T} WHERE player_id = ? AND currency = ?`, [
      playerId,
      currency,
    ]);
  }

  async save(wallet: Wallet, expectedVersion: number): Promise<void> {
    const record = walletMapper.toRecord(wallet);
    const rows = await this.uow
      .current()
      .execute<unknown[]>(
        `UPDATE ${T} SET balance = ?, version = ?, updated_at = ? WHERE id = ? AND version = ? RETURNING id`,
        [record.balance, record.version, record.updatedAt, record.id, expectedVersion],
      );
    if (rows.length !== 1) {
      throw new OptimisticLockError(
        `wallet ${wallet.id} is no longer at version ${expectedVersion}`,
      );
    }
  }

  private async one(sql: string, params: unknown[]): Promise<Wallet | null> {
    const rows = await fetchRecords<WalletRecord>(this.uow.current(), walletsTable, sql, params);
    return rows[0] ? walletMapper.toDomain(rows[0]) : null;
  }
}
