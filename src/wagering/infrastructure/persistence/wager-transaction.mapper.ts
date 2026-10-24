import { Money } from "../../../shared/kernel";
import {
  type FailureCode,
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain";

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  observedBalance: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
  updatedAt: Date;
}

const orUndefined = <T>(value: T | null): T | undefined => value ?? undefined;

export const wagerTransactionMapper = {
  /** `updatedAt` é metadado de persistência: o domínio não o conhece. */
  toRecord(tx: WagerTransaction, updatedAt: Date): WagerTransactionRecord {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.toJSON().amount,
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      status: tx.status,
      failureCode: tx.failureCode ?? null,
      observedBalance: tx.observedBalance?.toJSON().amount ?? null,
      attempts: tx.attempts,
      nextAttemptAt: tx.nextAttemptAt ?? null,
      createdAt: tx.createdAt,
      processedAt: tx.processedAt ?? null,
      updatedAt,
    };
  },

  toDomain(record: WagerTransactionRecord): WagerTransaction {
    const currency = record.currency;
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind as WagerTransactionKind,
      money: Money.from({ amount: record.amount, currency }),
      referenceExternalTransactionId: orUndefined(record.referenceExternalTransactionId),
      createdAt: record.createdAt,
      status: record.status as WagerTransactionStatus,
      referenceTransactionId: orUndefined(record.referenceTransactionId),
      failureCode: orUndefined(record.failureCode) as FailureCode | undefined,
      processedAt: orUndefined(record.processedAt),
      observedBalance:
        record.observedBalance === null
          ? undefined
          : Money.from({ amount: record.observedBalance, currency }),
      attempts: record.attempts,
      nextAttemptAt: orUndefined(record.nextAttemptAt),
    });
  },
};
