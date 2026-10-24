import { CurrencyMismatchError, type Money, requireDate, requireText } from "../../shared/kernel";
import { InsufficientFundsError, InvalidWalletError } from "./errors";
import { LedgerDirection } from "./ledger-direction";
import { WalletLedgerEntry } from "./wallet-ledger-entry";

/** Uma movimentação de saldo. Os ids vêm de fora: o domínio não gera identificadores nem lê o relógio. */
export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  createdAt: Date;
  /** Obrigatório quando `initialBalance > 0`: identifica o lançamento e a transação OPENING. */
  opening?: { entryId: string; transactionId: string };
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Lançamento `CREDIT` de abertura (`balanceBefore = 0`); `null` quando o saldo inicial é zero. */
  openingEntry: WalletLedgerEntry | null;
}

/** Estado persistido. `rehydrate` o aceita como está, sem revalidar. */
export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aggregate root. Saldo e ledger só mudam juntos: `debit` e `credit` aplicam o movimento e DEVOLVEM
 * o lançamento correspondente, sempre de forma atômica (se algo falha, a wallet fica intocada).
 * A concorrência não é responsabilidade do aggregate: quem chama deve tê-lo carregado sob lock.
 */
export class Wallet {
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this._createdAt = new Date(createdAt.getTime());
    this._updatedAt = new Date(updatedAt.getTime());
  }

  /**
   * Abre uma wallet com `version = 1`. A moeda é a do saldo inicial. Com saldo inicial positivo,
   * devolve também o lançamento de abertura, para que saldo e ledger nasçam consistentes.
   */
  static open(props: OpenWalletProps): OpenedWallet {
    const id = requireText(props.id, "wallet id");
    const playerId = requireText(props.playerId, "playerId");
    const createdAt = requireDate(props.createdAt, "createdAt");

    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError("initial balance must not be negative");
    }

    const wallet = new Wallet(
      id,
      playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      createdAt,
      createdAt,
    );

    if (props.initialBalance.isZero()) {
      return { wallet, openingEntry: null };
    }
    if (!props.opening) {
      throw new InvalidWalletError(
        "opening entry and transaction ids are required for a positive initial balance",
      );
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.entryId,
      walletId: id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: props.initialBalance.subtract(props.initialBalance),
      balanceAfter: props.initialBalance,
      createdAt,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência. NÃO revalida regras: só reconstrói estado já persistido. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  /** Começa em 1 e sobe em 1 a cada mudança de saldo, e somente nela. */
  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  /** Debita o valor; rejeita se o saldo for insuficiente. Devolve o lançamento `DEBIT`. */
  debit(movement: WalletMovement): WalletLedgerEntry {
    return this.move(LedgerDirection.Debit, movement);
  }

  /** Credita o valor. Devolve o lançamento `CREDIT`. */
  credit(movement: WalletMovement): WalletLedgerEntry {
    return this.move(LedgerDirection.Credit, movement);
  }

  private move(direction: LedgerDirection, movement: WalletMovement): WalletLedgerEntry {
    const at = requireDate(movement.at, "at");
    // Redundante de propósito: `Money` e o ledger também barram moedas diferentes, mas aqui falha
    // cedo e já com a moeda da wallet no erro.
    this.assertSameCurrency(movement.money);
    if (!movement.money.isPositive()) {
      throw new InvalidWalletError("movement amount must be positive");
    }

    const isDebit = direction === LedgerDirection.Debit;
    if (isDebit && this._balance.isLessThan(movement.money)) {
      throw new InsufficientFundsError();
    }

    // Tudo que pode falhar acontece ANTES de qualquer mutação: a wallet nunca fica pela metade.
    const balanceAfter = isDebit
      ? this._balance.subtract(movement.money)
      : this._balance.add(movement.money);
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
