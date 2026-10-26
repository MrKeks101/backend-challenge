import { Inject, Injectable } from "@nestjs/common";
import { RequestContext } from "../../shared/application/request-context";
import { CLOCK, ID_GENERATOR } from "../../shared/application/tokens";
import { UNIT_OF_WORK, type UnitOfWork } from "../../shared/application/unit-of-work";
import { type Clock, type IdGenerator, Money, type MoneyProps } from "../../shared/kernel";
import { WalletNotFoundError } from "../../wallet/application/errors";
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from "../../wallet/application/ports/wallet-repositories";
import {
  decideWagerOutcome,
  type FailureCode,
  WagerTransaction,
  type WagerTransactionKind,
} from "../domain";
import { ExternalTransactionIdConflictError, IdempotencyKeyConflictError } from "./errors";
import { WAGER_METRICS, type WagerMetrics } from "./ports/wager-metrics";
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from "./ports/wager-transaction-repository";
import { WagerOutcomeApplier } from "./wager-outcome-applier";

/** Comando já validado na borda (HTTP ou fila); o domínio revalida o que depende do `kind`. */
export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export interface ProcessContext {
  correlationId: string;
}

export interface ProcessResult {
  /** Estado persistido: o da 1ª execução (replay devolve o resultado ORIGINAL, AR-29). */
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

/** Repetições extras só para deadlock/serialização (RF-CON-03); nada além disso é repetido. */
const CONFLICT_RETRIES = 3;

/**
 * Caso de uso único de processamento (AR-50): a API HTTP e, no M9, o consumidor SQS chamam o mesmo.
 * Fluxo da ARCHITECTURE §7: claim de idempotência → lock da wallet → decisão pura → aplicação →
 * outbox, tudo numa transação SQL. A REJEIÇÃO de negócio é um resultado persistido (commit), não
 * uma exceção.
 */
@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(WagerOutcomeApplier) private readonly applier: WagerOutcomeApplier,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(WAGER_METRICS) private readonly metrics: WagerMetrics,
  ) {}

  /** Caminho síncrono (HTTP). O consumidor SQS usa `preflight` + `processInTransaction` e mede o seu. */
  async execute(
    command: ProcessWagerTransactionCommand,
    context: ProcessContext,
  ): Promise<ProcessResult> {
    const started = performance.now();
    await this.preflight(command);
    const result = await this.uow.run(() => this.processInTransaction(command, context), {
      retryOnConflict: CONFLICT_RETRIES,
    });
    // Depois do commit: uma transação repetida por deadlock não conta duas vezes.
    if (result.idempotentReplay) this.metrics.duplicate("replay");
    else this.metrics.transactionResolved(result.transaction.status, command.kind);
    this.metrics.observeProcessing("http", (performance.now() - started) / 1000);
    return result;
  }

  /**
   * §7.1: valida o comando e a existência da wallet ANTES de abrir a transação. Nada é gravado.
   * Lança `InvalidWagerTransactionError` ou `WalletNotFoundError`.
   */
  async preflight(command: ProcessWagerTransactionCommand): Promise<void> {
    this.build(command, this.clock.now());
    if (!(await this.wallets.findById(command.walletId))) throw new WalletNotFoundError();
  }

  /**
   * Registra, em transação própria, que o comando falhou de forma permanente (`FAILED`). Só cria o
   * registro se a idempotency key ainda não existe: uma transação com estado nunca é sobrescrita.
   * Devolve `false` quando não gravou nada.
   */
  async recordFailure(
    command: ProcessWagerTransactionCommand,
    code: FailureCode,
    context: ProcessContext,
  ): Promise<boolean> {
    return this.uow.run(async () => {
      const now = this.clock.now();
      const transaction = this.build(command, now);
      if (!(await this.transactions.claim(transaction))) return false;
      const wallet = await this.metrics.measureWalletLock(() =>
        this.wallets.findByIdForUpdate(transaction.walletId),
      );
      if (!wallet) throw new WalletNotFoundError();
      await this.applier.applyFailure({
        transaction,
        wallet,
        code,
        at: now,
        correlationId: context.correlationId,
      });
      return true;
    });
  }

  /**
   * §7.2 [1]–[6]. Exige estar numa transação aberta pelo chamador. Reconstrói o aggregate a cada
   * chamada, então repetir após um deadlock nunca reaproveita um objeto já mutado.
   */
  async processInTransaction(
    command: ProcessWagerTransactionCommand,
    context: ProcessContext,
  ): Promise<ProcessResult> {
    const now = this.clock.now();
    const transaction = this.build(command, now);
    RequestContext.enrich({
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
    });

    if (!(await this.transactions.claim(transaction))) {
      return this.resolveExisting(transaction, command.idempotencyKey);
    }

    const wallet = await this.metrics.measureWalletLock(() =>
      this.wallets.findByIdForUpdate(transaction.walletId),
    );
    if (!wallet) throw new WalletNotFoundError();

    const reference = transaction.referenceExternalTransactionId
      ? await this.transactions.findByExternalId(
          transaction.providerId,
          transaction.referenceExternalTransactionId,
        )
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
    await this.applier.apply({
      transaction,
      wallet,
      outcome,
      at: now,
      correlationId: context.correlationId,
    });
    return { transaction, idempotentReplay: false };
  }

  /**
   * O claim não criou a linha: ela já existe. Mesma key + mesmo payload = replay do resultado
   * original; mesma key + payload diferente, ou o mesmo id do provedor sob outra key = conflito.
   */
  private async resolveExisting(
    attempted: WagerTransaction,
    idempotencyKey: string,
  ): Promise<ProcessResult> {
    const byKey = await this.transactions.findByIdempotencyKey(idempotencyKey);
    if (byKey) {
      if (!byKey.matchesPayload(attempted.payloadHash)) throw new IdempotencyKeyConflictError();
      RequestContext.enrich({ transactionId: byKey.id }); // o id da transação ORIGINAL, não o descartado
      return { transaction: byKey, idempotentReplay: true };
    }
    const byExternalId = await this.transactions.findByExternalId(
      attempted.providerId,
      attempted.externalTransactionId,
    );
    if (byExternalId) throw new ExternalTransactionIdConflictError();
    throw new Error("idempotency claim conflicted but no existing transaction was found");
  }

  private build(command: ProcessWagerTransactionCommand, now: Date): WagerTransaction {
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: Money.from(command.money),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });
  }
}
