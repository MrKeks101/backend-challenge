import { describe, expect, test } from "bun:test";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { TEST_SQS_ENDPOINT } from "../support/infra";

// Spike M1: SDK SQS contra o MiniStack (o conjunto completo de comportamentos foi validado no D14).

describe("SQS (MiniStack) sob Bun", () => {
  test("fila FIFO: enviar com MessageGroupId, receber e deletar", async () => {
    const sqs = new SQSClient({
      region: "us-east-1",
      endpoint: TEST_SQS_ENDPOINT,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({
        QueueName: `spike-${Date.now()}.fifo`,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
      }),
    );
    expect(QueueUrl).toBeString();

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: QueueUrl as string,
        MessageBody: JSON.stringify({ hello: "world" }),
        MessageGroupId: "wallet-1",
        MessageDeduplicationId: "evt-1",
      }),
    );
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QueueUrl as string,
        WaitTimeSeconds: 2,
        MaxNumberOfMessages: 1,
      }),
    );
    const message = received.Messages?.[0];
    expect(received.Messages).toHaveLength(1);
    expect(JSON.parse(message?.Body ?? "null")).toEqual({ hello: "world" });
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: QueueUrl as string,
        ReceiptHandle: message?.ReceiptHandle as string,
      }),
    );
  });
});
