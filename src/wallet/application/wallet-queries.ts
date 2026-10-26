import { Inject, Injectable } from "@nestjs/common";
import type { Wallet, WalletLedgerEntry } from "../domain";
import { WalletNotFoundError } from "./errors";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor";
import {
  LEDGER_REPOSITORY,
  type LedgerRepository,
  WALLET_REPOSITORY,
  type WalletRepository,
} from "./ports/wallet-repositories";

@Injectable()
export class GetWalletQuery {
  constructor(@Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) throw new WalletNotFoundError();
    return wallet;
  }
}

export interface LedgerPageResult {
  entries: WalletLedgerEntry[];
  /** `null` na última página. */
  nextCursor: string | null;
}

@Injectable()
export class ListLedgerQuery {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
  ) {}

  /** Do mais novo para o mais antigo. O cursor aponta para o último `seq` entregue. */
  async execute(
    walletId: string,
    options: { limit: number; cursor?: string | undefined },
  ): Promise<LedgerPageResult> {
    // Decodifica antes de tocar o banco: cursor inválido é erro do cliente, não da wallet.
    const beforeSeq =
      options.cursor === undefined ? undefined : decodeLedgerCursor(options.cursor, walletId);
    if (!(await this.wallets.findById(walletId))) throw new WalletNotFoundError();

    const page = await this.ledger.page(walletId, {
      limit: options.limit,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    });
    return {
      entries: page.items.map((item) => item.entry),
      nextCursor:
        page.nextBeforeSeq === null ? null : encodeLedgerCursor(walletId, page.nextBeforeSeq),
    };
  }
}
