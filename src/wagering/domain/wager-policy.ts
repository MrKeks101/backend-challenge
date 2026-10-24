import { InvalidArgumentError, InvalidTransactionStateError } from "../../shared/kernel";
import { LedgerDirection, type Wallet } from "../../wallet/domain";
import { FailureCode } from "./failure-code";
import type { WagerTransaction } from "./wager-transaction";
import { WagerTransactionKind as Kind } from "./wager-transaction-kind";
import { WagerTransactionStatus } from "./wager-transaction-status";

/** Resultado da decisão de negócio. Quem chama aplica o resultado e persiste. */
export type WagerOutcome =
  | {
      type: "PROCESSED";
      /** `null` quando não há lançamento (LOSS). */
      direction: LedgerDirection | null;
      /** id interno da referência resolvida, quando houver. */
      referenceTransactionId: string | undefined;
    }
  | { type: "REJECTED"; code: FailureCode }
  | { type: "PENDING_REFERENCE" };

export interface WagerPolicyInput {
  transaction: WagerTransaction;
  /** Wallet carregada SOB LOCK (a decisão assume o saldo estável). */
  wallet: Wallet;
  /** Transação referenciada, resolvida por (providerId, referenceExternalTransactionId); `null` se não existe. */
  reference: WagerTransaction | null;
  /** Já existe um REFUND/ROLLBACK PROCESSED apontando para a referência. */
  referenceAlreadyReversed: boolean;
}

/** Tipos de referência aceitos por cada `kind` (regra 3 do README; WIN/LOSS referenciam a BET). */
const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<Kind, readonly Kind[]>>> = {
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
  [Kind.Win]: [Kind.Bet],
  [Kind.Loss]: [Kind.Bet],
};

const rejected = (code: FailureCode): WagerOutcome => ({ type: "REJECTED", code });

/**
 * Decisão de negócio PURA (sem I/O): dada a transação, a wallet sob lock e a referência, devolve
 * se a transação é aplicada, rejeitada (com `failureCode`) ou fica aguardando a referência.
 */
export function decideWagerOutcome(input: WagerPolicyInput): WagerOutcome {
  const { transaction, wallet, reference } = input;

  if (transaction.isTerminal()) {
    throw new InvalidTransactionStateError(transaction.status, "DECISION");
  }
  if (transaction.walletId !== wallet.id) {
    throw new InvalidArgumentError("the wallet does not belong to this transaction");
  }

  if (wallet.playerId !== transaction.playerId) return rejected(FailureCode.PlayerWalletMismatch);
  if (transaction.money.currency !== wallet.currency) return rejected(FailureCode.CurrencyMismatch);

  let referenceTransactionId: string | undefined;
  if (transaction.referenceExternalTransactionId !== undefined) {
    const blocked = checkReference(input);
    if (blocked) return blocked;
    referenceTransactionId = reference?.id;
  }

  return applyEffect(transaction, wallet, reference, referenceTransactionId);
}

/** `null` quando a referência está apta; caso contrário, o desfecho que a impede. */
function checkReference(input: WagerPolicyInput): WagerOutcome | null {
  const { transaction, reference } = input;

  if (reference === null) return { type: "PENDING_REFERENCE" };
  if (reference.externalTransactionId !== transaction.referenceExternalTransactionId) {
    throw new InvalidArgumentError("the reference does not match referenceExternalTransactionId");
  }

  // Fatos estáticos da referência vêm antes do status: uma referência de tipo errado ou de outro
  // jogador/rodada nunca vai "ficar certa" esperando.
  if (
    reference.providerId !== transaction.providerId ||
    reference.playerId !== transaction.playerId ||
    reference.walletId !== transaction.walletId ||
    reference.money.currency !== transaction.money.currency ||
    reference.roundId !== transaction.roundId
  ) {
    return rejected(FailureCode.ReferenceMismatch);
  }
  if (!ALLOWED_REFERENCE_KINDS[transaction.kind]?.includes(reference.kind)) {
    return rejected(FailureCode.ReferenceKindNotAllowed);
  }

  if (
    reference.status === WagerTransactionStatus.Pending ||
    reference.status === WagerTransactionStatus.PendingReference
  ) {
    return { type: "PENDING_REFERENCE" };
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return rejected(FailureCode.ReferenceNotProcessed);
  }

  if (transaction.requiresReference()) {
    if (!transaction.money.equals(reference.money)) {
      return rejected(FailureCode.ReferenceAmountMismatch);
    }
    if (input.referenceAlreadyReversed) return rejected(FailureCode.AlreadyReversed);
  } else if (input.referenceAlreadyReversed) {
    return rejected(FailureCode.ReferenceAlreadyReversed);
  }
  return null;
}

function applyEffect(
  transaction: WagerTransaction,
  wallet: Wallet,
  reference: WagerTransaction | null,
  referenceTransactionId: string | undefined,
): WagerOutcome {
  if (!transaction.affectsBalance()) {
    return { type: "PROCESSED", direction: null, referenceTransactionId };
  }

  const direction = transaction.ledgerDirectionFor(reference ?? undefined);
  if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(transaction.money)) {
    return rejected(
      transaction.kind === Kind.Bet
        ? FailureCode.InsufficientFunds
        : FailureCode.ReversalWouldOverdraw,
    );
  }
  return { type: "PROCESSED", direction, referenceTransactionId };
}
