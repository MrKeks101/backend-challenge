import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../database/database.module";
import { INBOX_REPOSITORY, OUTBOX_REPOSITORY } from "../application/ports/messaging-repositories";
import { OutboxBacklogReporter } from "./observability/outbox-backlog.reporter";
import {
  MikroOrmInboxRepository,
  MikroOrmOutboxRepository,
} from "./persistence/messaging.repositories";

@Module({
  imports: [DatabaseModule],
  providers: [
    { provide: INBOX_REPOSITORY, useClass: MikroOrmInboxRepository },
    { provide: OUTBOX_REPOSITORY, useClass: MikroOrmOutboxRepository },
    OutboxBacklogReporter,
  ],
  exports: [INBOX_REPOSITORY, OUTBOX_REPOSITORY],
})
export class MessagingPersistenceModule {}
