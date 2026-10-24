import {
  CurrencyMismatchError,
  DomainError,
  type Money,
  requireDate,
  requireText,
} from "../../shared/kernel";
import { InvalidLedgerEntryError } from "./errors";
import { LedgerDirection } from "./ledger-direction";

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/** Estado persistido. `rehydrate` o aceita como está, sem revalidar. */
export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento do ledger. IMUTÁVEL de forma estrutural: todos os campos são `readonly`, não existe
 * método de transição e a instância é congelada. Só nasce por `create` (valida a aritmética) ou
 * `rehydrate` (reconstrói estado já persistido).
 */
export class WalletLedgerEntry {
  private readonly _createdAt: Date;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this._createdAt = new Date(createdAt.getTime());
    Object.freeze(this);
  }

  /** Valida os campos e a regra `balanceBefore ± money === balanceAfter`. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const id = requireText(props.id, "ledger entry id");
    const walletId = requireText(props.walletId, "walletId");
    const transactionId = requireText(props.transactionId, "transactionId");
    const createdAt = requireDate(props.createdAt, "createdAt");

    if (props.direction !== LedgerDirection.Debit && props.direction !== LedgerDirection.Credit) {
      throw new InvalidLedgerEntryError("direction must be DEBIT or CREDIT");
    }
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError("ledger entry amount must be positive");
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError("balances must not be negative");
    }
    for (const balance of [props.balanceBefore, props.balanceAfter]) {
      if (balance.currency !== props.money.currency) {
        throw new CurrencyMismatchError(props.money.currency, balance.currency);
      }
    }

    const entry = new WalletLedgerEntry(
      id,
      walletId,
      transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      createdAt,
    );
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError("balanceBefore +/- money does not equal balanceAfter");
    }
    return entry;
  }

  /** Reconstrução a partir da persistência. NÃO revalida: confie no que o banco já garantiu. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  /** `balanceBefore ± money === balanceAfter`. Estado incoerente (moedas, estouro) conta como não balanceado. */
  isBalanced(): boolean {
    try {
      const expected =
        this.direction === LedgerDirection.Credit
          ? this.balanceBefore.add(this.money)
          : this.balanceBefore.subtract(this.money);
      return expected.equals(this.balanceAfter);
    } catch (error) {
      if (error instanceof DomainError) return false;
      throw error;
    }
  }
}
