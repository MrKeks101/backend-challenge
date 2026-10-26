import { Module } from "@nestjs/common";
import { MessagingPersistenceModule } from "../messaging/infrastructure/messaging-persistence.module";
import { OPENING_RECORDER } from "../wallet/application/ports/opening-recorder";
import { WageringOpeningRecorder } from "./application/wagering-opening-recorder";
import { WageringPersistenceModule } from "./infrastructure/wagering-persistence.module";

/** Casos de uso do contexto de Wagering. No M7 ganha o processamento de transações. */
@Module({
  imports: [WageringPersistenceModule, MessagingPersistenceModule],
  providers: [{ provide: OPENING_RECORDER, useClass: WageringOpeningRecorder }],
  exports: [OPENING_RECORDER],
})
export class WageringModule {}
