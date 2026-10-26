import { Inject, Injectable } from "@nestjs/common";
import { CLOCK } from "../../shared/application/tokens";
import { UNIT_OF_WORK, type UnitOfWork } from "../../shared/application/unit-of-work";
import type { Clock } from "../../shared/kernel";
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from "../../wallet/application/ports/wallet-repositories";
import {
  decideAfterFailedAttempt,
  decideWagerOutcome,
  FailureCode,
  WagerTransactionStatus,
} from "../domain";
import {
  PENDING_REFERENCE_SETTINGS,
  type PendingReferenceSettings,
} from "./pending-reference-settings";
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from "./ports/wager-transaction-repository";
import { WagerOutcomeApplier } from "./wager-outcome-applier";

export type ReprocessResult =
  /** Já não estava `PENDING_REFERENCE` (outra instância ou o wake-up resolveu): nada a fazer. */
  | "NOOP"
  | "PROCESSED"
  | "REJECTED"
  /** A referência ainda não chegou; nova tentativa agendada com backoff. */
  | "STILL_PENDING"
  /** Limite de tentativas ou TTL: rejeitada com `REFERENCE_NOT_FOUND`. */
  | "GAVE_UP";

const CONFLICT_RETRIES = 3;

/**
 * Reavalia UMA transação `PENDING_REFERENCE` (ARCHITECTURE §10, passo 2). Numa transação nova,
 * **trava a wallet primeiro** (mesma ordem do fluxo normal, então nunca há deadlock com ele), relê
 * a transação e confere que ainda está pendente, e reaplica a política com a referência atual.
 */
@Injectable()
export class ReprocessPendingTransactionUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(WagerOutcomeApplier) private readonly applier: WagerOutcomeApplier,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PENDING_REFERENCE_SETTINGS) private readonly pending: PendingReferenceSettings,
  ) {}

  async execute(
    transactionId: string,
    context: { correlationId: string },
  ): Promise<ReprocessResult> {
    const candidate = await this.transactions.findById(transactionId);
    if (!candidate || candidate.status !== WagerTransactionStatus.PendingReference) return "NOOP";

    return this.uow.run(() => this.reprocess(candidate.id, candidate.walletId, context), {
      retryOnConflict: CONFLICT_RETRIES,
    });
  }

  private async reprocess(
    transactionId: string,
    walletId: string,
    context: { correlationId: string },
  ): Promise<ReprocessResult> {
    const wallet = await this.wallets.findByIdForUpdate(walletId);
    if (!wallet) return "NOOP";

    // Relida sob o lock da wallet: quem a resolveu antes de nós já commitou.
    const transaction = await this.transactions.findById(transactionId);
    if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference) {
      return "NOOP";
    }

    const now = this.clock.now();
    const referenceExternalId = transaction.referenceExternalTransactionId;
    const reference = referenceExternalId
      ? await this.transactions.findByExternalId(transaction.providerId, referenceExternalId)
      : null;
    const referenceAlreadyReversed = reference
      ? await this.transactions.hasProcessedReversal(reference.id)
      : false;

    const outcome = decideWagerOutcome({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
    });
    const apply = { transaction, wallet, at: now, correlationId: context.correlationId };

    if (outcome.type !== "PENDING_REFERENCE") {
      await this.applier.apply({ ...apply, outcome });
      return outcome.type === "PROCESSED" ? "PROCESSED" : "REJECTED";
    }

    const decision = decideAfterFailedAttempt(
      transaction,
      now,
      this.pending.policy,
      this.pending.jitter(),
    );
    if (decision.action === "GIVE_UP") {
      await this.applier.apply({
        ...apply,
        outcome: { type: "REJECTED", code: FailureCode.ReferenceNotFound },
      });
      return "GAVE_UP";
    }

    transaction.markPendingReference(decision.nextAttemptAt);
    await this.transactions.update(transaction, now);
    return "STILL_PENDING";
  }
}
