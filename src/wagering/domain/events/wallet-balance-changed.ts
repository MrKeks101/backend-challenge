import {
  type EventContext,
  IntegrationEvent,
  InvalidArgumentError,
  type MoneyProps,
} from "../../../shared/kernel";
import type { LedgerDirection, Wallet, WalletLedgerEntry } from "../../../wallet/domain";

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Emitido SOMENTE quando o saldo muda (nunca para LOSS nem para rejeições). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  /**
   * Deve ser construído logo após aplicar a movimentação: confere que o lançamento pertence à
   * wallet e que o saldo dela é o `balanceAfter` do lançamento, para o evento nunca mentir.
   */
  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvalidArgumentError("the ledger entry does not belong to this wallet");
    }
    if (!entry.balanceAfter.equals(wallet.balance)) {
      throw new InvalidArgumentError("the wallet balance does not match the ledger entry");
    }
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
