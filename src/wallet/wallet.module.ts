import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { WageringModule } from "../wagering/wagering.module";
import { CreateWalletUseCase } from "./application/create-wallet.use-case";
import { RECONCILIATION_REPORTER } from "./application/ports/reconciliation-reporter";
import { ReconcileWalletUseCase } from "./application/reconcile-wallet.use-case";
import { GetWalletQuery, ListLedgerQuery } from "./application/wallet-queries";
import { PrometheusReconciliationReporter } from "./infrastructure/observability/prometheus-reconciliation-reporter";
import { WalletPersistenceModule } from "./infrastructure/wallet-persistence.module";
import { WalletController } from "./interfaces/http/wallet.controller";

@Module({
  imports: [DatabaseModule, WalletPersistenceModule, WageringModule],
  controllers: [WalletController],
  providers: [
    CreateWalletUseCase,
    GetWalletQuery,
    ListLedgerQuery,
    ReconcileWalletUseCase,
    { provide: RECONCILIATION_REPORTER, useClass: PrometheusReconciliationReporter },
  ],
})
export class WalletModule {}
