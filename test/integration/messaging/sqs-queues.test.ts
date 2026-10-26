import { afterAll, describe, expect, test } from "bun:test";
import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import {
  ensureQueues,
  MAX_RECEIVE_COUNT,
  queueNames,
} from "../../../src/messaging/infrastructure/sqs/ensure-queues";
import { QueueRegistry } from "../../../src/messaging/infrastructure/sqs/sqs.module";
import type { Env } from "../../../src/shared/infrastructure/config/env";
import { sqsClient, uniquePrefix } from "../../support/messaging";

const sqs = sqsClient();
afterAll(() => sqs.destroy());

async function attributes(queueUrl: string, names: string[]) {
  const res = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: names as never }),
  );
  return res.Attributes ?? {};
}

/** Cliente real que falha as primeiras `failures` chamadas (falha de rede injetada). */
function failFirst(real: SQSClient, failures: number) {
  const state = { calls: 0 };
  const client = {
    send: (command: unknown) => {
      state.calls++;
      if (state.calls <= failures) return Promise.reject(new Error("sqs fora do ar"));
      return real.send(command as never);
    },
  } as unknown as SQSClient;
  return { client, state };
}

describe("ensureQueues", () => {
  test("cria as três filas FIFO com os nomes do desafio", async () => {
    const urls = await ensureQueues(sqs, queueNames(uniquePrefix()));

    for (const url of Object.values(urls)) {
      expect((await attributes(url, ["FifoQueue"])).FifoQueue).toBe("true");
    }
    expect(urls.transactions).toEndWith("wager-transactions.fifo");
    expect(urls.transactionsDlq).toEndWith("wager-transactions-dlq.fifo");
    expect(urls.events).toEndWith("wager-events.fifo");
  });

  test("sem prefixo, os nomes são exatamente os do README", () => {
    expect(queueNames()).toEqual({
      transactions: "wager-transactions.fifo",
      transactionsDlq: "wager-transactions-dlq.fifo",
      events: "wager-events.fifo",
    });
  });

  test("a fila de entrada tem redrive nativo para a DLQ (maxReceiveCount = 5)", async () => {
    const urls = await ensureQueues(sqs, queueNames(uniquePrefix()));

    const entry = await attributes(urls.transactions, ["RedrivePolicy"]);
    const dlq = await attributes(urls.transactionsDlq, ["QueueArn", "RedrivePolicy"]);
    const policy = JSON.parse(entry.RedrivePolicy ?? "{}") as Record<string, unknown>;

    expect(MAX_RECEIVE_COUNT).toBe(5);
    expect(Number(policy.maxReceiveCount)).toBe(5); // allow-number: inteiro pequeno da política
    expect(policy.deadLetterTargetArn).toBe(dlq.QueueArn as string);
    expect(dlq.RedrivePolicy).toBeUndefined(); // a DLQ não reencaminha para lugar nenhum
  });

  test("é idempotente, inclusive chamada por vários processos ao mesmo tempo", async () => {
    const names = queueNames(uniquePrefix());

    const results = await Promise.all(Array.from({ length: 8 }, () => ensureQueues(sqs, names)));
    const again = await ensureQueues(sqs, names);

    for (const urls of results) expect(urls).toEqual(again);
  });
});

describe("QueueRegistry", () => {
  const registry = (client: SQSClient) =>
    new QueueRegistry(client, { SQS_QUEUE_PREFIX: uniquePrefix() } as Env);

  test("memoiza o sucesso: ensure() repetido não volta ao SQS", async () => {
    const counted = failFirst(sqs, 0);
    const queues = registry(counted.client);

    const first = await queues.ensure();
    const callsAfterFirst = counted.state.calls;
    const second = await queues.ensure();

    expect(second).toEqual(first);
    expect(counted.state.calls).toBe(callsAfterFirst);
  });

  test("chamadas simultâneas compartilham uma só criação", async () => {
    const counted = failFirst(sqs, 0);
    const queues = registry(counted.client);

    await Promise.all(Array.from({ length: 10 }, () => queues.ensure()));
    const callsForTen = counted.state.calls;
    const single = failFirst(sqs, 0);
    await registry(single.client).ensure();

    expect(callsForTen).toBe(single.state.calls);
  });

  test("a falha NÃO é memoizada: quando o SQS volta, a próxima chamada funciona", async () => {
    const flaky = failFirst(sqs, 1);
    const queues = registry(flaky.client);

    await expect(queues.ensure()).rejects.toThrow("sqs fora do ar");
    const urls = await queues.ensure();

    expect(urls.events).toEndWith("wager-events.fifo");
  });
});
