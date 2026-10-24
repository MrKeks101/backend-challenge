import { defineTable, money } from "../../../shared/infrastructure/persistence/table-def";

export const walletsTable = defineTable("wallets", "WalletRecord", {
  id: { column: "id", type: "uuid", primary: true },
  playerId: { column: "player_id", type: "uuid" },
  currency: { column: "currency", type: "char", length: 3 },
  balance: money("balance"),
  version: { column: "version", type: "integer" },
  createdAt: { column: "created_at", type: "timestamptz" },
  updatedAt: { column: "updated_at", type: "timestamptz" },
});

export const ledgerTable = defineTable("wallet_ledger_entries", "LedgerEntryRecord", {
  seq: { column: "seq", type: "bigint", generated: true },
  id: { column: "id", type: "uuid", primary: true },
  walletId: { column: "wallet_id", type: "uuid" },
  transactionId: { column: "transaction_id", type: "uuid" },
  direction: { column: "direction", type: "text" },
  amount: money("amount"),
  currency: { column: "currency", type: "char", length: 3 },
  balanceBefore: money("balance_before"),
  balanceAfter: money("balance_after"),
  createdAt: { column: "created_at", type: "timestamptz" },
});
