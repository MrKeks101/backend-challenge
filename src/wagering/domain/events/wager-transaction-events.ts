import {
  type EventContext,
  IntegrationEvent,
  InvalidArgumentError,
  type MoneyProps,
} from "../../../shared/kernel";
import type { WagerTransaction } from "../wager-transaction";
import { WagerTransactionStatus } from "../wager-transaction-status";
import { requireStatus, summarize, type TransactionSummary } from "./transaction-summary";

function requireObservedBalance(transaction: WagerTransaction): MoneyProps {
  const balance = transaction.observedBalance;
  if (!balance) throw new InvalidArgumentError("transaction has no observed balance");
  return balance.toJSON();
}

function requireProcessedAt(transaction: WagerTransaction): string {
  const at = transaction.processedAt;
  if (!at) throw new InvalidArgumentError("transaction has no terminal timestamp");
  return at.toISOString();
}

// ---------------------------------------------------------------------------

export interface WagerTransactionProcessedData extends TransactionSummary {
  /** Saldo da wallet após a aplicação (ou o saldo corrente, no caso de LOSS). */
  balance: MoneyProps;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS (que não move saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    requireStatus(transaction, WagerTransactionStatus.Processed, "WagerTransactionProcessed");
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...summarize(transaction),
        balance: requireObservedBalance(transaction),
        processedAt: requireProcessedAt(transaction),
      },
    });
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionRejectedData extends TransactionSummary {
  failureCode: string;
  /** `null` só em CURRENCY_MISMATCH: o saldo da wallet está em outra moeda. */
  balance: MoneyProps | null;
  rejectedAt: string;
}

/** Transação rejeitada por regra de negócio; carrega o `failureCode` estável. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    requireStatus(transaction, WagerTransactionStatus.Rejected, "WagerTransactionRejected");
    const failureCode = transaction.failureCode;
    if (!failureCode) throw new InvalidArgumentError("rejected transaction has no failure code");
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...summarize(transaction),
        failureCode,
        balance: transaction.observedBalance?.toJSON() ?? null,
        rejectedAt: requireProcessedAt(transaction),
      },
    });
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionPendingReferenceData extends TransactionSummary {
  nextAttemptAt: string;
}

/** Referência ausente: emitido uma vez, na 1ª vez que a transação passa a aguardar. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    requireStatus(
      transaction,
      WagerTransactionStatus.PendingReference,
      "WagerTransactionPendingReference",
    );
    const next = transaction.nextAttemptAt;
    if (!next) throw new InvalidArgumentError("pending transaction has no next attempt");
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.id,
      data: { ...summarize(transaction), nextAttemptAt: next.toISOString() },
    });
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionFailedData extends TransactionSummary {
  failureCode: string;
  failedAt: string;
}

/** Falha permanente de infraestrutura (evento extra, além dos 4 mínimos). */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionFailedData> {
  readonly eventType = "WagerTransactionFailed";
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    requireStatus(transaction, WagerTransactionStatus.Failed, "WagerTransactionFailed");
    const failureCode = transaction.failureCode;
    if (!failureCode) throw new InvalidArgumentError("failed transaction has no failure code");
    return new WagerTransactionFailed({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...summarize(transaction),
        failureCode,
        failedAt: requireProcessedAt(transaction),
      },
    });
  }
}
