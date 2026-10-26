import type { MoneyProps } from "../../../shared/kernel";
import type { ProcessResult } from "../../application/process-wager-transaction.use-case";
import { providerActionFor, type WagerTransaction, WagerTransactionStatus } from "../../domain";

export interface SubmissionResponse {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

const balanceOf = (transaction: WagerTransaction): MoneyProps | null =>
  transaction.observedBalance?.toJSON() ?? null;

/**
 * Mapeamento ÚNICO de resultado → HTTP (ARCHITECTURE §13.2), igual para a 1ª execução e para o
 * replay: o status descreve o ESTADO da transação, não se foi a primeira vez.
 *
 * | estado              | HTTP |
 * |---------------------|------|
 * | PROCESSED           | 200  |
 * | PENDING_REFERENCE   | 202  |
 * | REJECTED            | 422  |
 * | FAILED              | 500  |
 */
export function presentSubmission(result: ProcessResult): SubmissionResponse {
  const { transaction, idempotentReplay } = result;
  const base = {
    transactionId: transaction.id,
    status: transaction.status,
    balance: balanceOf(transaction),
    idempotentReplay,
  };

  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      return { status: 200, body: base, headers: {} };

    case WagerTransactionStatus.PendingReference:
      return {
        status: 202,
        body: base,
        headers: { Location: `/wagering/transactions/${transaction.id}` },
      };

    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed: {
      const failureCode = transaction.failureCode;
      if (!failureCode) throw new Error("terminal failure without failureCode");
      return {
        status: transaction.status === WagerTransactionStatus.Rejected ? 422 : 500,
        body: { ...base, failureCode, providerAction: providerActionFor(failureCode) },
        headers: {},
      };
    }

    case WagerTransactionStatus.Pending:
      throw new Error("a PENDING transaction is never committed");
  }
}

/** Estado completo da transação, para as consultas. Um `REJECTED` consultado é 200: é estado. */
export function presentTransaction(transaction: WagerTransaction) {
  const failureCode = transaction.failureCode;
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
    status: transaction.status,
    failureCode: failureCode ?? null,
    providerAction: failureCode ? providerActionFor(failureCode) : null,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    balance: balanceOf(transaction),
    attempts: transaction.attempts,
    nextAttemptAt: transaction.nextAttemptAt?.toISOString() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}
