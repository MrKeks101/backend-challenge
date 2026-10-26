import { Inject, Injectable } from "@nestjs/common";
import { UNIT_OF_WORK, type UnitOfWork } from "../../shared/application/unit-of-work";
import type { Money } from "../../shared/kernel";
import { WalletNotFoundError } from "./errors";
import {
  RECONCILIATION_REPORTER,
  type ReconciliationReporter,
} from "./ports/reconciliation-reporter";
import {
  LEDGER_REPOSITORY,
  type LedgerRepository,
  WALLET_REPOSITORY,
  type WalletRepository,
} from "./ports/wallet-repositories";

export interface ReconciliationResult {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  /** `storedBalance − calculatedBalance`; pode ser negativa. */
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(RECONCILIATION_REPORTER) private readonly reporter: ReconciliationReporter,
  ) {}

  /**
   * Compara o saldo guardado com a soma do ledger. Lê tudo num snapshot `REPEATABLE READ`, sem
   * lock: assim saldo e ledger vêm do mesmo instante mesmo com apostas em andamento, e a
   * reconciliação não bloqueia o processamento. Divergência é DADO (200 com `consistent: false`),
   * é sinalizada (log + métrica) e NUNCA corrigida (AR-42).
   */
  async execute(walletId: string, correlationId: string): Promise<ReconciliationResult> {
    const result = await this.uow.run(
      async () => {
        const wallet = await this.wallets.findById(walletId);
        if (!wallet) throw new WalletNotFoundError();
        const summary = await this.ledger.summarize(walletId, wallet.currency);
        const difference = wallet.balance.subtract(summary.net);
        return {
          walletId,
          storedBalance: wallet.balance,
          calculatedBalance: summary.net,
          difference,
          consistent: difference.isZero(),
          checkedEntries: summary.entries,
        };
      },
      { isolation: "REPEATABLE READ" },
    );

    if (!result.consistent) {
      this.reporter.divergenceDetected({
        walletId,
        checkedEntries: result.checkedEntries,
        correlationId,
      });
    }
    return result;
  }
}
