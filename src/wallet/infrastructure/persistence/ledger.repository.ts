import { Inject, Injectable } from "@nestjs/common";
import { fetchRecords } from "../../../shared/infrastructure/persistence/fetch-records";
import {
  type MikroOrmUnitOfWork,
  UNIT_OF_WORK_IMPL,
} from "../../../shared/infrastructure/persistence/mikro-orm-unit-of-work";
import { insertStatement, selectList } from "../../../shared/infrastructure/persistence/table-def";
import { InvalidArgumentError, Money } from "../../../shared/kernel";
import type {
  LedgerPage,
  LedgerRepository,
  LedgerSummary,
} from "../../application/ports/wallet-repositories";
import type { WalletLedgerEntry } from "../../domain";
import { ledgerTable } from "./tables";
import { type LedgerEntryRecord, ledgerMapper } from "./wallet.mapper";

const COLUMNS = selectList(ledgerTable);
const T = ledgerTable.name;
const SEQ = /^[0-9]{1,18}$/;

@Injectable()
export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(@Inject(UNIT_OF_WORK_IMPL) private readonly uow: MikroOrmUnitOfWork) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    const { sql, params } = insertStatement(ledgerTable, ledgerMapper.toRecord(entry));
    await this.uow.current().execute(sql, params);
  }

  async findByTransaction(
    walletId: string,
    transactionId: string,
  ): Promise<WalletLedgerEntry | null> {
    const rows = await fetchRecords<LedgerEntryRecord>(
      this.uow.current(),
      ledgerTable,
      `SELECT ${COLUMNS} FROM ${T} WHERE wallet_id = ? AND transaction_id = ?`,
      [walletId, transactionId],
    );
    return rows[0] ? ledgerMapper.toDomain(rows[0]) : null;
  }

  async findLast(walletId: string): Promise<WalletLedgerEntry | null> {
    const rows = await fetchRecords<LedgerEntryRecord>(
      this.uow.current(),
      ledgerTable,
      `SELECT ${COLUMNS} FROM ${T} WHERE wallet_id = ? ORDER BY seq DESC LIMIT 1`,
      [walletId],
    );
    return rows[0] ? ledgerMapper.toDomain(rows[0]) : null;
  }

  async page(
    walletId: string,
    options: { limit: number; beforeSeq?: string },
  ): Promise<LedgerPage> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) {
      throw new InvalidArgumentError("limit must be an integer between 1 and 200");
    }
    if (options.beforeSeq !== undefined && !SEQ.test(options.beforeSeq)) {
      throw new InvalidArgumentError("beforeSeq must be a numeric string");
    }
    // Busca limit+1 para saber se há próxima página sem uma segunda consulta.
    const rows = await fetchRecords<LedgerEntryRecord>(
      this.uow.current(),
      ledgerTable,
      `SELECT ${COLUMNS} FROM ${T} WHERE wallet_id = ?${options.beforeSeq ? " AND seq < ?" : ""} ORDER BY seq DESC LIMIT ?`,
      [walletId, ...(options.beforeSeq ? [options.beforeSeq] : []), options.limit + 1],
    );
    const hasMore = rows.length > options.limit;
    const items = rows.slice(0, options.limit).map((row) => ({
      seq: row.seq as string,
      entry: ledgerMapper.toDomain(row),
    }));
    return { items, nextBeforeSeq: hasMore ? (items.at(-1)?.seq ?? null) : null };
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const rows = await this.uow.current().execute<{ entries: string; net: string }[]>(
      `SELECT count(*)::text AS entries,
              COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(38,2)::text AS net
         FROM ${T} WHERE wallet_id = ?`,
      [walletId],
    );
    const row = rows[0];
    if (!row) throw new Error("ledger summary returned no row");
    const negative = row.net.startsWith("-");
    const magnitude = Money.from({ amount: negative ? row.net.slice(1) : row.net, currency });
    const entries = Number(row.entries); // allow-number: contagem de linhas, não é dinheiro
    return { entries, net: negative ? magnitude.negate() : magnitude };
  }
}
