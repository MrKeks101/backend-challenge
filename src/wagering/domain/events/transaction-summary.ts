import type { MoneyProps } from "../../../shared/kernel";
import { InvalidArgumentError } from "../../../shared/kernel";
import type { WagerTransaction } from "../wager-transaction";
import type { WagerTransactionStatus } from "../wager-transaction-status";

/** Campos comuns dos eventos de transação. JSON puro: dinheiro como `MoneyProps`, ausentes como `null`. */
export interface TransactionSummary {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
}

export function summarize(transaction: WagerTransaction): TransactionSummary {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
  };
}

/** O evento descreve um estado já alcançado: construí-lo antes dele é erro de programação. */
export function requireStatus(
  transaction: WagerTransaction,
  expected: WagerTransactionStatus,
  event: string,
): void {
  if (transaction.status !== expected) {
    throw new InvalidArgumentError(`${event} requires a transaction in status ${expected}`);
  }
}
