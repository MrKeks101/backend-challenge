import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { MessagingPersistenceModule } from "../messaging/infrastructure/messaging-persistence.module";
import { OPENING_RECORDER } from "../wallet/application/ports/opening-recorder";
import { WalletPersistenceModule } from "../wallet/infrastructure/wallet-persistence.module";
import { ProcessWagerTransactionUseCase } from "./application/process-wager-transaction.use-case";
import { WagerOutcomeApplier } from "./application/wager-outcome-applier";
import { GetTransactionQuery } from "./application/wager-queries";
import { WageringOpeningRecorder } from "./application/wagering-opening-recorder";
import { WageringPersistenceModule } from "./infrastructure/wagering-persistence.module";
import { WageringController } from "./interfaces/http/wagering.controller";

/** Casos de uso e API do contexto de Wagering. */
@Module({
  imports: [
    DatabaseModule,
    WageringPersistenceModule,
    WalletPersistenceModule,
    MessagingPersistenceModule,
  ],
  controllers: [WageringController],
  providers: [
    WagerOutcomeApplier,
    ProcessWagerTransactionUseCase,
    GetTransactionQuery,
    { provide: OPENING_RECORDER, useClass: WageringOpeningRecorder },
  ],
  exports: [OPENING_RECORDER, WagerOutcomeApplier, ProcessWagerTransactionUseCase],
})
export class WageringModule {}
