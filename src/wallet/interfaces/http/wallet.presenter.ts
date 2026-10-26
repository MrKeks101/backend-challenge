import type { MoneyProps } from "../../../shared/kernel";
import type { ReconciliationResult } from "../../application/reconcile-wallet.use-case";
import type { LedgerPageResult } from "../../application/wallet-queries";
import type { Wallet } from "../../domain";

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export function presentWallet(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export function presentWalletDetails(wallet: Wallet) {
  return {
    ...presentWallet(wallet),
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function presentLedgerPage(page: LedgerPageResult) {
  return {
    items: page.entries.map((entry) => ({
      id: entry.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      createdAt: entry.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
  };
}

export function presentReconciliation(result: ReconciliationResult) {
  return {
    walletId: result.walletId,
    storedBalance: result.storedBalance.toJSON(),
    calculatedBalance: result.calculatedBalance.toJSON(),
    difference: result.difference.toJSON(),
    consistent: result.consistent,
    checkedEntries: result.checkedEntries,
  };
}
