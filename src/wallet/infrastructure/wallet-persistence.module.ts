import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../database/database.module";
import { LEDGER_REPOSITORY, WALLET_REPOSITORY } from "../application/ports/wallet-repositories";
import { MikroOrmLedgerRepository } from "./persistence/ledger.repository";
import { MikroOrmWalletRepository } from "./persistence/wallet.repository";

@Module({
  imports: [DatabaseModule],
  providers: [
    { provide: WALLET_REPOSITORY, useClass: MikroOrmWalletRepository },
    { provide: LEDGER_REPOSITORY, useClass: MikroOrmLedgerRepository },
  ],
  exports: [WALLET_REPOSITORY, LEDGER_REPOSITORY],
})
export class WalletPersistenceModule {}
