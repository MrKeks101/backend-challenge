import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, ID_GENERATOR } from "../../shared/application/tokens";
import { UNIT_OF_WORK, type UnitOfWork } from "../../shared/application/unit-of-work";
import { type Clock, type IdGenerator, Money, type MoneyProps } from "../../shared/kernel";
import { Wallet } from "../domain";
import { WalletAlreadyExistsError } from "./errors";
import { OPENING_RECORDER, type OpeningRecorder } from "./ports/opening-recorder";
import {
  LEDGER_REPOSITORY,
  type LedgerRepository,
  WALLET_REPOSITORY,
  type WalletRepository,
} from "./ports/wallet-repositories";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @Inject(OPENING_RECORDER) private readonly opening: OpeningRecorder,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /**
   * Wallet, transação OPENING, lançamento `CREDIT` e eventos nascem numa só transação SQL. A
   * duplicata `(playerId, moeda)` é decidida pelo banco (`ON CONFLICT DO NOTHING`): sob criação
   * concorrente, uma vence e as demais recebem `WalletAlreadyExistsError`, sem nada gravado.
   */
  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const initialBalance = Money.from(command.initialBalance);
    const at = this.clock.now();
    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance,
      createdAt: at,
      ...(initialBalance.isZero()
        ? {}
        : { opening: { entryId: this.ids.next(), transactionId: this.ids.next() } }),
    });

    await this.uow.run(async () => {
      if (!(await this.wallets.insert(wallet))) throw new WalletAlreadyExistsError();
      if (openingEntry) {
        await this.opening.recordOpening({
          wallet,
          entry: openingEntry,
          correlationId: command.correlationId,
          at,
        });
        await this.ledger.append(openingEntry);
      }
    });
    return wallet;
  }
}
