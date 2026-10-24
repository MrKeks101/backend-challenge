import { MikroORM } from "@mikro-orm/postgresql";
import { createOrm } from "../../src/database/orm";
import {
  MikroOrmInboxRepository,
  MikroOrmOutboxRepository,
} from "../../src/messaging/infrastructure/persistence/messaging.repositories";
import { MikroOrmUnitOfWork } from "../../src/shared/infrastructure/persistence/mikro-orm-unit-of-work";
import { type IdGenerator, Uuid7Generator } from "../../src/shared/kernel";
import { MikroOrmWagerTransactionRepository } from "../../src/wagering/infrastructure/persistence/wager-transaction.repository";
import { MikroOrmLedgerRepository } from "../../src/wallet/infrastructure/persistence/ledger.repository";
import { MikroOrmWalletRepository } from "../../src/wallet/infrastructure/persistence/wallet.repository";
import { TEST_DATABASE_URL } from "./infra";

export interface TestDatabase {
  name: string;
  url: string;
  orm: MikroORM;
  uow: MikroOrmUnitOfWork;
  wallets: MikroOrmWalletRepository;
  ledger: MikroOrmLedgerRepository;
  transactions: MikroOrmWagerTransactionRepository;
  inbox: MikroOrmInboxRepository;
  outbox: MikroOrmOutboxRepository;
  ids: IdGenerator;
  /** SQL cru (fora de qualquer transação), útil para preparar/inspecionar o banco. */
  sql<T = Record<string, unknown>[]>(query: string, params?: unknown[]): Promise<T>;
  close(): Promise<void>;
}

async function withAdmin<T>(fn: (admin: MikroORM) => Promise<T>): Promise<T> {
  const admin = await MikroORM.init({
    clientUrl: TEST_DATABASE_URL,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    pool: { min: 0, max: 1 },
  });
  try {
    return await fn(admin);
  } finally {
    await admin.close(true);
  }
}

/**
 * Banco NOVO para a suíte, com todas as migrations aplicadas. O ledger é append-only (nem TRUNCATE
 * é permitido), então o isolamento entre suítes vem de banco descartável, nunca de limpeza.
 */
export async function createTestDatabase(
  options: { migrate?: boolean; poolMax?: number } = {},
): Promise<TestDatabase> {
  const name = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await withAdmin((admin) => admin.em.execute(`CREATE DATABASE "${name}"`));

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const orm = await createOrm(url.toString(), { poolMax: options.poolMax ?? 20 });
  if (options.migrate !== false) await orm.migrator.up();

  const uow = new MikroOrmUnitOfWork(orm);
  return {
    name,
    url: url.toString(),
    orm,
    uow,
    wallets: new MikroOrmWalletRepository(uow),
    ledger: new MikroOrmLedgerRepository(uow),
    transactions: new MikroOrmWagerTransactionRepository(uow),
    inbox: new MikroOrmInboxRepository(uow),
    outbox: new MikroOrmOutboxRepository(uow),
    ids: new Uuid7Generator(),
    sql: (query, params) => orm.em.fork().execute(query, params) as never,
    async close() {
      await orm.close(true);
      await withAdmin((admin) =>
        admin.em.execute(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
      );
    },
  };
}

/**
 * Invariantes globais que valem em QUALQUER momento entre transações. Devolve a lista de
 * violações (vazia = íntegro). Todo teste de integração termina chamando `expectInvariants`.
 */
export async function findInvariantViolations(db: TestDatabase): Promise<string[]> {
  const violations: string[] = [];
  const add = (label: string, rows: unknown[]) => {
    for (const row of rows) violations.push(`${label}: ${JSON.stringify(row)}`);
  };

  add("saldo negativo", await db.sql(`SELECT id, balance FROM wallets WHERE balance < 0`));
  add(
    "saldo != balance_after do último lançamento",
    await db.sql(`
      SELECT w.id, w.balance, COALESCE(l.balance_after, 0) AS ledger_last
      FROM wallets w
      LEFT JOIN LATERAL (
        SELECT balance_after FROM wallet_ledger_entries WHERE wallet_id = w.id ORDER BY seq DESC LIMIT 1
      ) l ON true
      WHERE w.balance <> COALESCE(l.balance_after, 0)`),
  );
  add(
    "saldo != soma do ledger (créditos − débitos)",
    await db.sql(`
      SELECT w.id, w.balance, COALESCE(s.total, 0) AS ledger_sum
      FROM wallets w
      LEFT JOIN (
        SELECT wallet_id, SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) AS total
        FROM wallet_ledger_entries GROUP BY wallet_id
      ) s ON s.wallet_id = w.id
      WHERE w.balance <> COALESCE(s.total, 0)`),
  );
  add(
    "encadeamento balance_before/after quebrado",
    await db.sql(`
      SELECT wallet_id, seq FROM (
        SELECT wallet_id, seq, balance_before,
               COALESCE(LAG(balance_after) OVER (PARTITION BY wallet_id ORDER BY seq), 0) AS expected_before
        FROM wallet_ledger_entries
      ) c WHERE balance_before <> expected_before`),
  );
  add(
    "lançamento de transação que não está PROCESSED",
    await db.sql(`
      SELECT l.id, t.status FROM wallet_ledger_entries l
      JOIN wager_transactions t ON t.id = l.transaction_id WHERE t.status <> 'PROCESSED'`),
  );
  add(
    "transação PROCESSED que move saldo, sem lançamento",
    await db.sql(`
      SELECT t.id, t.kind FROM wager_transactions t
      WHERE t.status = 'PROCESSED' AND t.kind <> 'LOSS'
        AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries l WHERE l.transaction_id = t.id)`),
  );
  add(
    "LOSS com lançamento",
    await db.sql(`
      SELECT t.id FROM wager_transactions t
      WHERE t.kind = 'LOSS' AND EXISTS (SELECT 1 FROM wallet_ledger_entries l WHERE l.transaction_id = t.id)`),
  );
  add(
    "transação revertida mais de uma vez",
    await db.sql(`
      SELECT reference_transaction_id, COUNT(*) FROM wager_transactions
      WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')
      GROUP BY reference_transaction_id HAVING COUNT(*) > 1`),
  );
  return violations;
}

export async function expectInvariants(db: TestDatabase): Promise<void> {
  const violations = await findInvariantViolations(db);
  if (violations.length > 0) {
    throw new Error(`invariantes violadas:\n${violations.join("\n")}`);
  }
}
