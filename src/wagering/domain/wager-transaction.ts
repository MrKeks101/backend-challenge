import {
  InvalidArgumentError,
  InvalidTransactionStateError,
  type Money,
  requireDate,
  requireText,
} from "../../shared/kernel";
import { LedgerDirection } from "../../wallet/domain";
import { InvalidWagerTransactionError } from "./errors";
import { FAILURE_CODES, type FailureCode, REJECTION_CODES } from "./failure-code";
import { computePayloadHash } from "./payload-hash";
import { WagerTransactionKind } from "./wager-transaction-kind";
import { WagerTransactionStatus } from "./wager-transaction-status";

/** Limite de tamanho dos identificadores vindos do provedor. */
const MAX_ID_LENGTH = 200;

/** Transições válidas. Os três estados terminais não saem de lá. */
const ALLOWED_TRANSITIONS: Readonly<
  Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>
> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export type CreateOpeningTransactionProps = Pick<
  CreateWagerTransactionProps,
  "id" | "walletId" | "playerId" | "money" | "createdAt"
>;

/** Estado persistido. `rehydrate` o aceita como está, sem revalidar. */
export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  observedBalance: Money | undefined;
  attempts: number;
  nextAttemptAt: Date | undefined;
}

/** Identificação do provedor para transações internas (OPENING). */
export const INTERNAL_PROVIDER_ID = "internal";

/**
 * Transação de aposta. Nasce `PENDING`; as transições são explícitas e `PROCESSED`, `REJECTED` e
 * `FAILED` são terminais: tentar mexer numa transação terminal é erro de programação
 * (`InvalidTransactionStateError`), não caminho de negócio.
 */
export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  /** id no provedor — não o id interno */
  public readonly referenceExternalTransactionId: string | undefined;

  private readonly _createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _observedBalance: Money | undefined;
  private _attempts: number;
  private _nextAttemptAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this._createdAt = new Date(state.createdAt.getTime());
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt ? new Date(state.processedAt.getTime()) : undefined;
    this._observedBalance = state.observedBalance;
    this._attempts = state.attempts;
    this._nextAttemptAt = state.nextAttemptAt ? new Date(state.nextAttemptAt.getTime()) : undefined;
  }

  /**
   * Nasce em `PENDING`. Valida o que depende do `kind`: `OPENING` é interno e rejeitado aqui;
   * `REFUND`/`ROLLBACK` exigem referência; `BET` não pode ter; valores seguem a regra do `kind`.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError("OPENING is internal and cannot be submitted");
    }
    return WagerTransaction.build(props);
  }

  /** Caminho INTERNO do crédito de abertura da wallet: não é alcançável pela API nem pela fila. */
  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    return WagerTransaction.build({
      ...props,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: props.walletId,
      idempotencyKey: `opening:${props.walletId}`,
      roundId: "opening",
      gameId: "opening",
      kind: WagerTransactionKind.Opening,
    });
  }

  /** Reconstrução a partir da persistência. NÃO revalida regras nem transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    const id = requireText(props.id, "transaction id");
    const providerId = requireText(props.providerId, "providerId", MAX_ID_LENGTH);
    const externalTransactionId = requireText(
      props.externalTransactionId,
      "externalTransactionId",
      MAX_ID_LENGTH,
    );
    const idempotencyKey = requireText(props.idempotencyKey, "idempotencyKey", MAX_ID_LENGTH);
    const walletId = requireText(props.walletId, "walletId");
    const playerId = requireText(props.playerId, "playerId");
    const roundId = requireText(props.roundId, "roundId", MAX_ID_LENGTH);
    const gameId = requireText(props.gameId, "gameId", MAX_ID_LENGTH);
    const createdAt = requireDate(props.createdAt, "createdAt");

    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError("unknown transaction kind");
    }
    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError("amount must not be negative");
    }
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError("amount must be positive for this kind");
    }

    const reference =
      props.referenceExternalTransactionId === undefined
        ? undefined
        : requireText(
            props.referenceExternalTransactionId,
            "referenceExternalTransactionId",
            MAX_ID_LENGTH,
          );
    const needsReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    const forbidsReference =
      props.kind === WagerTransactionKind.Bet || props.kind === WagerTransactionKind.Opening;
    if (needsReference && reference === undefined) {
      throw new InvalidWagerTransactionError("this kind requires referenceExternalTransactionId");
    }
    if (forbidsReference && reference !== undefined) {
      throw new InvalidWagerTransactionError("this kind cannot have a reference");
    }
    if (reference !== undefined && reference === externalTransactionId) {
      throw new InvalidWagerTransactionError("a transaction cannot reference itself");
    }

    return new WagerTransaction({
      id,
      providerId,
      externalTransactionId,
      idempotencyKey,
      payloadHash: computePayloadHash({
        providerId,
        externalTransactionId,
        playerId,
        walletId,
        roundId,
        gameId,
        kind: props.kind,
        money: props.money,
        referenceExternalTransactionId: reference,
      }),
      walletId,
      playerId,
      roundId,
      gameId,
      kind: props.kind,
      money: props.money,
      referenceExternalTransactionId: reference,
      createdAt,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
      observedBalance: undefined,
      attempts: 0,
      nextAttemptAt: undefined,
    });
  }

  // ---- leitura

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  /** id INTERNO da transação referenciada, preenchido ao processar. */
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  /** Momento em que a transação chegou a um estado terminal (processada, rejeitada ou falha). */
  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt.getTime()) : undefined;
  }

  /** Saldo da wallet observado na decisão; é o que o replay devolve (RF-BIZ-07). */
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  /** Quantas vezes o reprocessamento já tentou resolver a referência sem sucesso. */
  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt ? new Date(this._nextAttemptAt.getTime()) : undefined;
  }

  // ---- transições (lançam InvalidTransactionStateError se o estado atual for terminal)

  /**
   * Aplicada. `referenceTransactionId` é o id interno da referência resolvida (obrigatório para
   * REFUND/ROLLBACK). `observedBalance` é o saldo da wallet após a decisão.
   */
  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    observedBalance: Money,
  ): void {
    this.assertCanMoveTo(WagerTransactionStatus.Processed);
    const when = requireDate(at, "at");
    this.assertObservedBalance(observedBalance);
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new InvalidWagerTransactionError("this kind requires the resolved reference id");
    }
    if (this.referenceExternalTransactionId === undefined && referenceTransactionId !== undefined) {
      throw new InvalidWagerTransactionError("this transaction has no reference to resolve");
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._observedBalance = observedBalance;
    this._processedAt = when;
    this._nextAttemptAt = undefined;
  }

  /**
   * Aguarda a referência. Da 1ª vez (`PENDING`) zera as tentativas; a cada nova tentativa que
   * ainda não achou a referência (`PENDING_REFERENCE`) soma 1.
   */
  markPendingReference(nextAttemptAt: Date): void {
    this.assertCanMoveTo(WagerTransactionStatus.PendingReference);
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidWagerTransactionError("only transactions with a reference can wait for it");
    }
    const when = requireDate(nextAttemptAt, "nextAttemptAt");
    this._attempts =
      this._status === WagerTransactionStatus.PendingReference ? this._attempts + 1 : 0;
    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = when;
  }

  /** Rejeitada por regra de negócio. Só aceita códigos de rejeição (não os de falha técnica). */
  reject(code: FailureCode, observedBalance: Money, at: Date): void {
    this.assertCanMoveTo(WagerTransactionStatus.Rejected);
    if (!REJECTION_CODES.has(code)) {
      throw new InvalidArgumentError("failure code is not a business rejection code");
    }
    const when = requireDate(at, "at");
    this.assertObservedBalance(observedBalance);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._processedAt = when;
    this._nextAttemptAt = undefined;
  }

  /** Erro permanente de infraestrutura. Só aceita códigos de falha técnica. */
  fail(code: FailureCode, at: Date): void {
    this.assertCanMoveTo(WagerTransactionStatus.Failed);
    if (!FAILURE_CODES.has(code)) {
      throw new InvalidArgumentError("failure code is not a technical failure code");
    }
    const when = requireDate(at, "at");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = when;
    this._nextAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return ALLOWED_TRANSITIONS[this._status].length === 0;
  }

  /** `false` só para LOSS: registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** `true` para REFUND e ROLLBACK. */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Sentido do lançamento no ledger. BET debita; WIN, REFUND e OPENING creditam; ROLLBACK é o
   * INVERSO do sentido da referência (que é obrigatória). LOSS não tem lançamento.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError(
            "ROLLBACK needs its reference to know the direction",
          );
        }
        if (!reference.affectsBalance() || reference.kind === WagerTransactionKind.Rollback) {
          throw new InvalidWagerTransactionError(
            "this reference has no reversible ledger direction",
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError("LOSS has no ledger direction");
    }
  }

  private assertCanMoveTo(target: WagerTransactionStatus): void {
    if (!ALLOWED_TRANSITIONS[this._status].includes(target)) {
      throw new InvalidTransactionStateError(this._status, target);
    }
  }

  private assertObservedBalance(balance: Money): void {
    if (balance.currency !== this.money.currency) {
      throw new InvalidWagerTransactionError(
        "observed balance must be in the transaction currency",
      );
    }
  }
}
