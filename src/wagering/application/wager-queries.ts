import { Inject, Injectable } from "@nestjs/common";
import type { WagerTransaction } from "../domain";
import { TransactionNotFoundError } from "./errors";
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from "./ports/wager-transaction-repository";

@Injectable()
export class GetTransactionQuery {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
  ) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    const found = await this.transactions.findById(transactionId);
    if (!found) throw new TransactionNotFoundError();
    return found;
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const found = await this.transactions.findByExternalId(providerId, externalTransactionId);
    if (!found) throw new TransactionNotFoundError();
    return found;
  }
}
