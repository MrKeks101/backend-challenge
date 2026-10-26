import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable } from "@nestjs/common";
import type { EventPublisher } from "../../application/ports/event-publisher";
import type { OutboxMessage } from "../../domain";
import { QueueRegistry, SQS_CLIENT } from "./sqs.module";

/**
 * Publica no `wager-events.fifo`. `MessageGroupId` é a wallet (ordem relativa por wallet) e
 * `MessageDeduplicationId` é o `eventId`: o FIFO descarta a republicação do mesmo evento dentro
 * da janela de 5 minutos, e fora dela o consumidor deduplica por `eventId`.
 */
@Injectable()
export class SqsEventPublisher implements EventPublisher {
  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(QueueRegistry) private readonly queues: QueueRegistry,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    const { events } = await this.queues.ensure();
    const correlationId = message.payload.correlationId;
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: events,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.messageGroupId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: "String", StringValue: message.eventType },
          eventId: { DataType: "String", StringValue: message.id },
          ...(typeof correlationId === "string"
            ? { correlationId: { DataType: "String", StringValue: correlationId } }
            : {}),
        },
      }),
    );
  }
}
