import type { EventContext, Money } from "../../src/shared/kernel";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from "../../src/wagering/domain";
import { Wallet } from "../../src/wallet/domain";
import { brl } from "./money";

export const T0 = new Date("2026-01-01T00:00:00.000Z");
export const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}-${++sequence}`;

/** Wallet BRL de `player-1`, id `wallet-1`, com o saldo informado. */
export function makeWallet(balance = "100.00", overrides: { playerId?: string } = {}): Wallet {
  return Wallet.rehydrate({
    id: "wallet-1",
    playerId: overrides.playerId ?? "player-1",
    currency: "BRL",
    balance: brl(balance),
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });
}

/** Transação nova (PENDING) com padrões coerentes com `makeWallet()`. */
export function makeTx(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId("ext");
  return WagerTransaction.create({
    id: nextId("tx"),
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: brl("25.00"),
    createdAt: T0,
    ...overrides,
  });
}

/** Transação já PROCESSED (útil como referência). `balance` é o saldo observado. */
export function makeProcessed(
  overrides: Partial<CreateWagerTransactionProps> = {},
  balance: Money = brl("75.00"),
): WagerTransaction {
  const tx = makeTx(overrides);
  tx.markProcessed(tx.requiresReference() ? "resolved-ref-id" : undefined, at(1), balance);
  return tx;
}

let eventSequence = 0;
export function eventContext(overrides: Partial<EventContext> = {}): EventContext {
  return {
    eventId: `evt-${++eventSequence}`,
    correlationId: "corr-1",
    occurredAt: at(10),
    ...overrides,
  };
}
