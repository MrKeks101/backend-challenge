import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WagerTransactionKind as Kind } from "../../../src/wagering/domain";
import {
  createTestDatabase,
  findInvariantViolations,
  type TestDatabase,
} from "../../support/database";
import { brl } from "../../support/money";
import { applyInDb, newTx, openWalletInDb } from "../../support/persisted-flow";

/**
 * O checker é a rede de segurança de todos os outros testes; ele próprio precisa ser provado.
 * Corrompe o banco DESLIGANDO os triggers (como um bug/operador faria) e confere que ele acusa.
 */
let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});

async function withoutGuards<T>(fn: () => Promise<T>): Promise<T> {
  await db.sql(`ALTER TABLE wallets DISABLE TRIGGER USER`);
  await db.sql(`ALTER TABLE wallet_ledger_entries DISABLE TRIGGER USER`);
  try {
    return await fn();
  } finally {
    await db.sql(`ALTER TABLE wallets ENABLE TRIGGER USER`);
    await db.sql(`ALTER TABLE wallet_ledger_entries ENABLE TRIGGER USER`);
  }
}

describe("findInvariantViolations", () => {
  test("banco vazio e banco com fluxo saudável não têm violações", async () => {
    expect(await findInvariantViolations(db)).toEqual([]);
    const wallet = await openWalletInDb(db, "100.00");
    const bet = newTx(db, wallet, { money: brl("30.00") });
    await applyInDb(db, bet);
    await applyInDb(
      db,
      newTx(db, wallet, {
        kind: Kind.Win,
        money: brl("5.00"),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    await applyInDb(
      db,
      newTx(db, wallet, {
        kind: Kind.Loss,
        money: brl("0.00"),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(await findInvariantViolations(db)).toEqual([]);
  });

  test("detecta saldo alterado sem ledger", async () => {
    const wallet = await openWalletInDb(db, "100.00");
    await withoutGuards(() =>
      db.sql(`UPDATE wallets SET balance = 90.00 WHERE id = ?`, [wallet.id]),
    );
    const violations = await findInvariantViolations(db);
    expect(
      violations.some((v) => v.startsWith("saldo != balance_after") && v.includes(wallet.id)),
    ).toBe(true);
    expect(
      violations.some((v) => v.startsWith("saldo != soma do ledger") && v.includes(wallet.id)),
    ).toBe(true);
    await withoutGuards(() =>
      db.sql(`UPDATE wallets SET balance = 100.00 WHERE id = ?`, [wallet.id]),
    );
    expect(await findInvariantViolations(db)).toEqual([]);
  });

  test("detecta saldo negativo", async () => {
    const wallet = await openWalletInDb(db, "1.00");
    await db.sql(`ALTER TABLE wallets DROP CONSTRAINT wallets_balance_check`);
    await withoutGuards(() =>
      db.sql(`UPDATE wallets SET balance = -1.00 WHERE id = ?`, [wallet.id]),
    );
    expect((await findInvariantViolations(db)).some((v) => v.startsWith("saldo negativo"))).toBe(
      true,
    );
    await withoutGuards(() =>
      db.sql(`UPDATE wallets SET balance = 1.00 WHERE id = ?`, [wallet.id]),
    );
    await db.sql(`ALTER TABLE wallets ADD CONSTRAINT wallets_balance_check CHECK (balance >= 0)`);
    expect(await findInvariantViolations(db)).toEqual([]);
  });

  test("detecta encadeamento quebrado do ledger", async () => {
    const wallet = await openWalletInDb(db, "100.00");
    await applyInDb(db, newTx(db, wallet, { money: brl("10.00") }));
    await applyInDb(db, newTx(db, wallet, { money: brl("10.00") }));
    // o 2º lançamento passa a afirmar um 'antes' incoerente (mas aritmeticamente válido)
    await withoutGuards(() =>
      db.sql(
        `UPDATE wallet_ledger_entries SET balance_before = 95.00, balance_after = 85.00
         WHERE wallet_id = ? AND balance_before = 90.00`,
        [wallet.id],
      ),
    );
    expect((await findInvariantViolations(db)).some((v) => v.startsWith("encadeamento"))).toBe(
      true,
    );
  });

  test("detecta transação PROCESSED que move saldo, sem lançamento", async () => {
    const fresh = await createTestDatabase();
    try {
      const wallet = await openWalletInDb(fresh, "100.00");
      const bet = newTx(fresh, wallet);
      await applyInDb(fresh, bet);
      await withoutGuards2(fresh, () =>
        fresh.sql(`DELETE FROM wallet_ledger_entries WHERE transaction_id = ?`, [bet.id]),
      );
      const violations = await findInvariantViolations(fresh);
      expect(
        violations.some((v) => v.startsWith("transação PROCESSED que move saldo, sem lançamento")),
      ).toBe(true);
    } finally {
      await fresh.close();
    }
  });

  test("detecta reversão múltipla e lançamento de transação não processada", async () => {
    const fresh = await createTestDatabase();
    try {
      const wallet = await openWalletInDb(fresh, "100.00");
      const bet = newTx(fresh, wallet);
      await applyInDb(fresh, bet);
      const refund = newTx(fresh, wallet, {
        kind: Kind.Refund,
        money: bet.money,
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      await applyInDb(fresh, refund);
      expect(await findInvariantViolations(fresh)).toEqual([]);

      // sem o índice parcial, um 2º estorno PROCESSED passaria: o checker precisa acusar
      await fresh.sql(`DROP INDEX uq_wager_single_reversal`);
      const second = newTx(fresh, wallet, {
        kind: Kind.Rollback,
        money: bet.money,
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      await fresh.transactions.claim(second);
      await fresh.sql(
        `UPDATE wager_transactions SET status = 'PROCESSED', processed_at = now(), reference_transaction_id = ? WHERE id = ?`,
        [bet.id, second.id],
      );
      expect(
        (await findInvariantViolations(fresh)).some((v) =>
          v.startsWith("transação revertida mais de uma vez"),
        ),
      ).toBe(true);

      // um lançamento cuja transação deixou de estar PROCESSED
      await fresh.sql(
        `UPDATE wager_transactions SET status = 'FAILED', failure_code = 'X' WHERE id = ?`,
        [bet.id],
      );
      expect(
        (await findInvariantViolations(fresh)).some((v) =>
          v.startsWith("lançamento de transação que não está PROCESSED"),
        ),
      ).toBe(true);
    } finally {
      await fresh.close();
    }
  });
});

async function withoutGuards2<T>(target: TestDatabase, fn: () => Promise<T>): Promise<T> {
  await target.sql(`ALTER TABLE wallet_ledger_entries DISABLE TRIGGER USER`);
  try {
    return await fn();
  } finally {
    await target.sql(`ALTER TABLE wallet_ledger_entries ENABLE TRIGGER USER`);
  }
}
