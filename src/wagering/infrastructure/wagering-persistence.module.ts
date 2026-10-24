import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../database/database.module";
import { WAGER_TRANSACTION_REPOSITORY } from "../application/ports/wager-transaction-repository";
import { MikroOrmWagerTransactionRepository } from "./persistence/wager-transaction.repository";

@Module({
  imports: [DatabaseModule],
  providers: [
    { provide: WAGER_TRANSACTION_REPOSITORY, useClass: MikroOrmWagerTransactionRepository },
  ],
  exports: [WAGER_TRANSACTION_REPOSITORY],
})
export class WageringPersistenceModule {}
