import { Inject, Injectable } from "@nestjs/common";
import {
  OUTBOX_REPOSITORY,
  type OutboxRepository,
} from "../../messaging/application/ports/messaging-repositories";
import { OutboxMessage } from "../../messaging/domain";
import { ID_GENERATOR } from "../../shared/application/tokens";
import type { IdGenerator } from "../../shared/kernel";
import type {
  OpeningRecorder,
  RecordOpeningInput,
} from "../../wallet/application/ports/opening-recorder";
import { WagerTransaction, WagerTransactionProcessed, WalletBalanceChanged } from "../domain";
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from "./ports/wager-transaction-repository";

/**
 * Registra a transação interna `OPENING` de uma wallet nova: nasce `PROCESSED` e emite
 * `WagerTransactionProcessed` + `WalletBalanceChanged` pela outbox, na transação de quem chama.
 */
@Injectable()
export class WageringOpeningRecorder implements OpeningRecorder {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async recordOpening({ wallet, entry, correlationId, at }: RecordOpeningInput): Promise<void> {
    const opening = WagerTransaction.createOpening({
      id: entry.transactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: entry.money,
      createdAt: at,
    });
    if (!(await this.transactions.claim(opening))) {
      throw new Error("opening transaction already exists for a brand-new wallet");
    }
    opening.markProcessed(undefined, at, entry.balanceAfter);
    await this.transactions.update(opening, at);

    const context = () => ({
      eventId: this.ids.next(),
      correlationId,
      causationId: opening.id,
      occurredAt: at,
    });
    await this.outbox.add(
      OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, context()), wallet.id),
    );
    await this.outbox.add(
      OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, context()), wallet.id),
    );
  }
}
