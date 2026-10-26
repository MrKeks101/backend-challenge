import { Inject, Injectable } from "@nestjs/common";
import {
  OUTBOX_REPOSITORY,
  type OutboxRepository,
} from "../../messaging/application/ports/messaging-repositories";
import { OutboxMessage } from "../../messaging/domain";
import { ID_GENERATOR } from "../../shared/application/tokens";
import {
  type EventContext,
  type IdGenerator,
  type IntegrationEvent,
  InvalidArgumentError,
} from "../../shared/kernel";
import {
  LEDGER_REPOSITORY,
  type LedgerRepository,
  WALLET_REPOSITORY,
  type WalletRepository,
} from "../../wallet/application/ports/wallet-repositories";
import { LedgerDirection, type Wallet } from "../../wallet/domain";
import {
  type FailureCode,
  firstPendingReferenceAttemptAt,
  type WagerOutcome,
  type WagerTransaction,
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionStatus,
  WalletBalanceChanged,
} from "../domain";
import {
  PENDING_REFERENCE_SETTINGS,
  type PendingReferenceSettings,
} from "./pending-reference-settings";
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from "./ports/wager-transaction-repository";

export interface ApplyOutcomeInput {
  transaction: WagerTransaction;
  /** A MESMA instância da wallet usada na decisão, carregada sob lock. */
  wallet: Wallet;
  outcome: WagerOutcome;
  at: Date;
  correlationId: string;
}

/**
 * Passo [5]+[6] do fluxo (ARCHITECTURE §7.2): grava o desfecho decidido — saldo, ledger, estado da
 * transação, eventos da outbox e acordar dependentes. Não abre transação: roda DENTRO da do
 * chamador, que já tem a wallet travada. Compartilhado pelo caso de uso e pelo reprocessador.
 */
@Injectable()
export class WagerOutcomeApplier {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(PENDING_REFERENCE_SETTINGS) private readonly pending: PendingReferenceSettings,
  ) {}

  async apply({
    transaction,
    wallet,
    outcome,
    at,
    correlationId,
  }: ApplyOutcomeInput): Promise<void> {
    const context = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId,
      causationId: transaction.id,
      occurredAt: at,
    });

    switch (outcome.type) {
      case "PENDING_REFERENCE": {
        if (transaction.status !== WagerTransactionStatus.Pending) {
          throw new InvalidArgumentError("only a new transaction enters PENDING_REFERENCE here");
        }
        transaction.markPendingReference(
          firstPendingReferenceAttemptAt(at, this.pending.policy, this.pending.jitter()),
        );
        await this.transactions.update(transaction, at);
        await this.emit(WagerTransactionPendingReference.from(transaction, context()), wallet);
        return;
      }

      case "REJECTED": {
        transaction.reject(outcome.code, wallet.balance, at);
        await this.transactions.update(transaction, at);
        await this.emit(WagerTransactionRejected.from(transaction, context()), wallet);
        await this.wakeDependents(transaction, at);
        return;
      }

      case "PROCESSED": {
        const entry =
          outcome.direction === null
            ? null
            : await this.move(transaction, wallet, outcome.direction, at);
        transaction.markProcessed(outcome.referenceTransactionId, at, wallet.balance);
        await this.transactions.update(transaction, at);
        await this.emit(WagerTransactionProcessed.from(transaction, context()), wallet);
        if (entry) await this.emit(WalletBalanceChanged.from(wallet, entry, context()), wallet);
        await this.wakeDependents(transaction, at);
        return;
      }
    }
  }

  /**
   * Falha técnica permanente (`FAILED`): audita que a transação não pôde ser processada. Não mexe
   * em saldo nem acorda dependentes (a transação não virou `PROCESSED` nem `REJECTED`).
   */
  async applyFailure({
    transaction,
    wallet,
    code,
    at,
    correlationId,
  }: {
    transaction: WagerTransaction;
    wallet: Wallet;
    code: FailureCode;
    at: Date;
    correlationId: string;
  }): Promise<void> {
    transaction.fail(code, at);
    await this.transactions.update(transaction, at);
    await this.emit(
      WagerTransactionFailed.from(transaction, {
        eventId: this.ids.next(),
        correlationId,
        causationId: transaction.id,
        occurredAt: at,
      }),
      wallet,
    );
  }

  /** Débito/crédito + `UPDATE … WHERE version` + lançamento. Devolve o lançamento criado. */
  private async move(
    transaction: WagerTransaction,
    wallet: Wallet,
    direction: LedgerDirection,
    at: Date,
  ) {
    const expectedVersion = wallet.version;
    const movement = {
      entryId: this.ids.next(),
      transactionId: transaction.id,
      money: transaction.money,
      at,
    };
    const entry =
      direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    await this.wallets.save(wallet, expectedVersion);
    await this.ledger.append(entry);
    return entry;
  }

  private emit(event: IntegrationEvent<unknown>, wallet: Wallet): Promise<void> {
    return this.outbox.add(OutboxMessage.enqueue(event, wallet.id));
  }

  /** Quem espera esta transação como referência passa a estar vencido para o reprocessador. */
  private async wakeDependents(transaction: WagerTransaction, at: Date): Promise<void> {
    await this.transactions.wakeDependents(
      transaction.providerId,
      transaction.externalTransactionId,
      at,
    );
  }
}
