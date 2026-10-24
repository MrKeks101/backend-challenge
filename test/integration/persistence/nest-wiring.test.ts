import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Global, type INestApplicationContext, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DatabaseModule } from "../../../src/database/database.module";
import {
  INBOX_REPOSITORY,
  OUTBOX_REPOSITORY,
} from "../../../src/messaging/application/ports/messaging-repositories";
import { MessagingPersistenceModule } from "../../../src/messaging/infrastructure/messaging-persistence.module";
import {
  MikroOrmInboxRepository,
  MikroOrmOutboxRepository,
} from "../../../src/messaging/infrastructure/persistence/messaging.repositories";
import { UNIT_OF_WORK, type UnitOfWork } from "../../../src/shared/application/unit-of-work";
import { ENV } from "../../../src/shared/infrastructure/config/config.module";
import {
  MikroOrmUnitOfWork,
  UNIT_OF_WORK_IMPL,
} from "../../../src/shared/infrastructure/persistence/mikro-orm-unit-of-work";
import { WAGER_TRANSACTION_REPOSITORY } from "../../../src/wagering/application/ports/wager-transaction-repository";
import { MikroOrmWagerTransactionRepository } from "../../../src/wagering/infrastructure/persistence/wager-transaction.repository";
import { WageringPersistenceModule } from "../../../src/wagering/infrastructure/wagering-persistence.module";
import {
  LEDGER_REPOSITORY,
  WALLET_REPOSITORY,
  type WalletRepository,
} from "../../../src/wallet/application/ports/wallet-repositories";
import { MikroOrmLedgerRepository } from "../../../src/wallet/infrastructure/persistence/ledger.repository";
import { MikroOrmWalletRepository } from "../../../src/wallet/infrastructure/persistence/wallet.repository";
import { WalletPersistenceModule } from "../../../src/wallet/infrastructure/wallet-persistence.module";
import { createTestDatabase, type TestDatabase } from "../../support/database";
import { openWalletInDb } from "../../support/persisted-flow";

let db: TestDatabase;
let app: INestApplicationContext;

beforeAll(async () => {
  db = await createTestDatabase();

  @Global()
  @Module({
    providers: [{ provide: ENV, useValue: { DATABASE_URL: db.url } }],
    exports: [ENV],
  })
  class TestConfigModule {}

  @Module({
    imports: [
      TestConfigModule,
      DatabaseModule,
      WalletPersistenceModule,
      WageringPersistenceModule,
      MessagingPersistenceModule,
    ],
  })
  class TestAppModule {}

  app = await NestFactory.createApplicationContext(TestAppModule, { logger: false });
});

afterAll(async () => {
  await app?.close();
  await db.close();
});

describe("wiring do Nest (sem emitDecoratorMetadata: tudo por @Inject + Symbol)", () => {
  test("cada porta resolve para a implementação MikroORM", () => {
    expect(app.get(WALLET_REPOSITORY)).toBeInstanceOf(MikroOrmWalletRepository);
    expect(app.get(LEDGER_REPOSITORY)).toBeInstanceOf(MikroOrmLedgerRepository);
    expect(app.get(WAGER_TRANSACTION_REPOSITORY)).toBeInstanceOf(
      MikroOrmWagerTransactionRepository,
    );
    expect(app.get(INBOX_REPOSITORY)).toBeInstanceOf(MikroOrmInboxRepository);
    expect(app.get(OUTBOX_REPOSITORY)).toBeInstanceOf(MikroOrmOutboxRepository);
  });

  test("UNIT_OF_WORK (porta) e a implementação são a MESMA instância (um só contexto transacional)", () => {
    expect(app.get(UNIT_OF_WORK)).toBe(app.get(UNIT_OF_WORK_IMPL));
    expect(app.get(UNIT_OF_WORK_IMPL)).toBeInstanceOf(MikroOrmUnitOfWork);
  });

  test("os repositórios injetados compartilham a transação do Unit of Work injetado", async () => {
    const uow = app.get<UnitOfWork>(UNIT_OF_WORK);
    const wallets = app.get<WalletRepository>(WALLET_REPOSITORY);
    const seeded = await openWalletInDb(db, "42.00"); // grava por outro caminho (db.*), lê pelo Nest
    const found = await uow.run(() => wallets.findByIdForUpdate(seeded.id));
    expect(found?.balance.toString()).toBe("42.00 BRL");
  });

  test("o Nest e os helpers de teste enxergam o mesmo banco", async () => {
    const wallets = app.get<WalletRepository>(WALLET_REPOSITORY);
    const seeded = await openWalletInDb(db, "7.00");
    expect((await wallets.findById(seeded.id))?.id).toBe(seeded.id);
  });
});
