import { describe, expect, test } from "bun:test";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type {
  Disposition,
  IncomingMessage,
  MessageHandler,
} from "../../../src/messaging/application/ports/message-handler";
import type { QueueRegistry } from "../../../src/messaging/infrastructure/sqs/sqs.module";
import {
  type ConsumerConfig,
  SqsConsumer,
  visibilityBackoffSeconds,
} from "../../../src/messaging/infrastructure/sqs/sqs-consumer";
import { AppMetrics } from "../../../src/shared/infrastructure/metrics/metrics";
import { metricValue } from "../../support/metrics";

/**
 * Semântica do consumidor (ack, retry, DLQ, ordem do grupo, shutdown) com um SQS roteirizado.
 * A integração com o SQS real está em test/integration/messaging.
 */
const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condição não atingida");
    await tick(2);
  }
}

interface Call {
  type: "delete" | "visibility" | "send";
  handle?: string;
  seconds?: number;
  input?: Record<string, any>;
}

/** SQS falso: entrega os lotes roteirizados e depois bloqueia o poll até o abort. */
class FakeSqs {
  readonly calls: Call[] = [];
  failSend = false;
  failDelete = false;
  private polls = 0;

  constructor(private readonly batches: (Message[] | Error)[]) {}

  send = async (command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> => {
    if (command instanceof ReceiveMessageCommand) {
      const next = this.batches[this.polls++];
      if (next instanceof Error) throw next;
      if (next) return { Messages: next };
      await new Promise<never>((_, reject) => {
        const signal = options?.abortSignal;
        // Como o SDK real: um signal já abortado rejeita na hora.
        if (signal?.aborted) return reject(new Error("aborted"));
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    if (command instanceof DeleteMessageCommand) {
      if (this.failDelete) throw new Error("delete failed");
      this.calls.push({ type: "delete", handle: command.input.ReceiptHandle as string });
      return {};
    }
    if (command instanceof ChangeMessageVisibilityCommand) {
      this.calls.push({
        type: "visibility",
        handle: command.input.ReceiptHandle as string,
        seconds: command.input.VisibilityTimeout as number,
      });
      return {};
    }
    if (command instanceof SendMessageCommand) {
      if (this.failSend) throw new Error("dlq down");
      this.calls.push({ type: "send", input: command.input as Record<string, any> });
      return {};
    }
    throw new Error("comando inesperado");
  };
}

const queues = {
  ensure: async () => ({ transactions: "in", transactionsDlq: "dlq", events: "ev" }),
} as unknown as QueueRegistry;

const message = (
  id: string,
  group: string,
  receiveCount = 1,
  body = `{"id":"${id}"}`,
): Message => ({
  MessageId: `sqs-${id}`,
  ReceiptHandle: `h-${id}`,
  Body: body,
  Attributes: { MessageGroupId: group, ApproximateReceiveCount: String(receiveCount) } as any,
});

function build(
  fake: FakeSqs,
  handle: (m: IncomingMessage) => Promise<Disposition> | Disposition,
  overrides: Partial<ConsumerConfig> = {},
  metrics = new AppMetrics(),
) {
  const handler: MessageHandler = { handle: async (m) => handle(m) };
  return new SqsConsumer(
    fake as unknown as SQSClient,
    queues,
    handler,
    {
      pollers: 1,
      batchSize: 10,
      waitSeconds: 1,
      shutdownGraceMs: 2_000,
      retryDelaySeconds: (count) => count * 10,
      ...overrides,
    },
    metrics,
  );
}

const kinds = (fake: FakeSqs) => fake.calls.map((c) => `${c.type}:${c.handle ?? ""}`);

describe("métricas do consumidor", () => {
  test("RETRY conta uma reentrega agendada", async () => {
    const metrics = new AppMetrics();
    const fake = new FakeSqs([[message("a", "g1", 2)]]);
    const consumer = build(fake, () => ({ action: "RETRY", reason: "x" }), {}, metrics);

    consumer.start();
    await waitFor(() => fake.calls.length >= 1);
    await consumer.stop();

    expect(await metricValue(metrics, "wager_retries_total", { stage: "sqs_redelivery" })).toBe(1);
    expect(await metricValue(metrics, "dlq_messages_total")).toBe(0);
  });

  test("DEAD_LETTER conta a mensagem na DLQ, por motivo, só depois de enviada", async () => {
    const metrics = new AppMetrics();
    const fake = new FakeSqs([[message("a", "g1")]]);
    const consumer = build(
      fake,
      () => ({ action: "DEAD_LETTER", reason: "INVALID_MESSAGE" }),
      {},
      metrics,
    );

    consumer.start();
    await waitFor(() => fake.calls.length >= 2);
    await consumer.stop();

    expect(await metricValue(metrics, "dlq_messages_total", { reason: "INVALID_MESSAGE" })).toBe(1);
    expect(await metricValue(metrics, "wager_retries_total")).toBe(0);
  });

  test("DLQ indisponível: nada foi para a DLQ, então não conta", async () => {
    const metrics = new AppMetrics();
    const fake = new FakeSqs([[message("a", "g1", 2)]]);
    fake.failSend = true;
    const consumer = build(fake, () => ({ action: "DEAD_LETTER", reason: "X" }), {}, metrics);

    consumer.start();
    await waitFor(() => fake.calls.length >= 1);
    await consumer.stop();

    expect(await metricValue(metrics, "dlq_messages_total")).toBe(0);
  });

  test("ACK não mexe nas métricas de retry nem de DLQ", async () => {
    const metrics = new AppMetrics();
    const fake = new FakeSqs([[message("a", "g1")]]);
    const consumer = build(fake, () => ({ action: "ACK", outcome: "PROCESSED" }), {}, metrics);

    consumer.start();
    await waitFor(() => fake.calls.length >= 1);
    await consumer.stop();

    expect(await metricValue(metrics, "wager_retries_total")).toBe(0);
    expect(await metricValue(metrics, "dlq_messages_total")).toBe(0);
  });
});

describe("desfecho de cada mensagem", () => {
  test("ACK: apaga e nada mais", async () => {
    const fake = new FakeSqs([[message("a", "g1")]]);
    const consumer = build(fake, () => ({ action: "ACK", outcome: "PROCESSED" }));

    consumer.start();
    await waitFor(() => fake.calls.length >= 1);
    await consumer.stop();

    expect(kinds(fake)).toEqual(["delete:h-a"]);
  });

  test("RETRY: NÃO apaga; muda a visibilidade pelo backoff do nº de entregas", async () => {
    const fake = new FakeSqs([[message("a", "g1", 3)]]);
    const consumer = build(fake, () => ({ action: "RETRY", reason: "x" }));

    consumer.start();
    await waitFor(() => fake.calls.length >= 1);
    await consumer.stop();

    expect(fake.calls).toEqual([{ type: "visibility", handle: "h-a", seconds: 30 }]);
  });

  test("DEAD_LETTER: envia à DLQ com os atributos de erro e SÓ DEPOIS apaga", async () => {
    const fake = new FakeSqs([[message("a", "g1", 4, '{"x":1}')]]);
    const consumer = build(fake, () => ({
      action: "DEAD_LETTER",
      reason: "INVALID_MESSAGE",
      detail: "data.kind: invalid_value",
    }));

    consumer.start();
    await waitFor(() => fake.calls.length >= 2);
    await consumer.stop();

    expect(fake.calls.map((c) => c.type)).toEqual(["send", "delete"]);
    const input = fake.calls[0]?.input ?? {};
    expect(input.QueueUrl).toBe("dlq");
    expect(input.MessageBody).toBe('{"x":1}');
    expect(input.MessageGroupId).toBe("g1");
    expect(input.MessageDeduplicationId).toBe("sqs-a");
    expect(input.MessageAttributes.errorReason.StringValue).toBe("INVALID_MESSAGE");
    expect(input.MessageAttributes.errorDetail.StringValue).toBe("data.kind: invalid_value");
    expect(input.MessageAttributes.originalMessageId.StringValue).toBe("sqs-a");
    expect(input.MessageAttributes.receiveCount).toEqual({ DataType: "Number", StringValue: "4" });
    expect(input.MessageAttributes.failedAt.StringValue).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("DLQ indisponível: o original NÃO é apagado e volta depois do backoff", async () => {
    const fake = new FakeSqs([[message("a", "g1", 2)]]);
    fake.failSend = true;
    const consumer = build(fake, () => ({ action: "DEAD_LETTER", reason: "X" }));

    consumer.start();
    await waitFor(() => fake.calls.length >= 1);
    await consumer.stop();

    expect(fake.calls).toEqual([{ type: "visibility", handle: "h-a", seconds: 20 }]);
  });

  test("detalhe longo é truncado no atributo", async () => {
    const fake = new FakeSqs([[message("a", "g1")]]);
    const consumer = build(fake, () => ({
      action: "DEAD_LETTER",
      reason: "X",
      detail: "d".repeat(2_000),
    }));

    consumer.start();
    await waitFor(() => fake.calls.length >= 2);
    await consumer.stop();

    expect(fake.calls[0]?.input?.MessageAttributes.errorDetail.StringValue).toHaveLength(500);
  });

  test("o handler que lança vira RETRY (nunca ack)", async () => {
    const fake = new FakeSqs([[message("a", "g1")]]);
    const consumer = build(fake, () => {
      throw new Error("bug");
    });

    consumer.start();
    await waitFor(() => fake.calls.length >= 1);
    await consumer.stop();

    expect(kinds(fake)).toEqual(["visibility:h-a"]);
  });

  test("falha no delete não derruba o lote: a próxima mensagem segue", async () => {
    const fake = new FakeSqs([[message("a", "g1"), message("b", "g1")]]);
    fake.failDelete = true;
    const seen: string[] = [];
    const consumer = build(fake, (m) => {
      seen.push(m.body);
      return { action: "ACK", outcome: "PROCESSED" };
    });

    consumer.start();
    await waitFor(() => seen.length >= 2);
    await consumer.stop();

    expect(seen).toEqual(['{"id":"a"}', '{"id":"b"}']);
  });

  test("o nº de entregas (ApproximateReceiveCount) chega ao handler", async () => {
    const fake = new FakeSqs([[message("a", "g1", 4)]]);
    const counts: number[] = [];
    const consumer = build(fake, (m) => {
      counts.push(m.receiveCount);
      return { action: "ACK", outcome: "X" };
    });

    consumer.start();
    await waitFor(() => counts.length >= 1);
    await consumer.stop();

    expect(counts).toEqual([4]);
  });

  test("contagem ausente ou inválida vira 1", async () => {
    const odd: Message = {
      ...message("a", "g1"),
      Attributes: { MessageGroupId: "g1", ApproximateReceiveCount: "abc" } as any,
    };
    const none: Message = { ...message("b", "g2"), Attributes: { MessageGroupId: "g2" } as any };
    const fake = new FakeSqs([[odd, none]]);
    const counts: number[] = [];
    const consumer = build(fake, (m) => {
      counts.push(m.receiveCount);
      return { action: "ACK", outcome: "X" };
    });

    consumer.start();
    await waitFor(() => counts.length >= 2);
    await consumer.stop();

    expect(counts).toEqual([1, 1]);
  });
});

describe("ordem dentro do lote", () => {
  test("mesmo grupo: em série e em ordem; grupos diferentes: em paralelo", async () => {
    const fake = new FakeSqs([
      [message("a1", "A"), message("a2", "A"), message("a3", "A"), message("b1", "B")],
    ]);
    const active = new Map<string, number>();
    let peakPerGroup = 0;
    let bothGroupsAtOnce = false;
    const order: string[] = [];
    const consumer = build(fake, async (m) => {
      const id = (JSON.parse(m.body) as { id: string }).id;
      const group = id.slice(0, 1).toUpperCase();
      active.set(group, (active.get(group) ?? 0) + 1);
      peakPerGroup = Math.max(peakPerGroup, active.get(group) ?? 0);
      if ((active.get("A") ?? 0) > 0 && (active.get("B") ?? 0) > 0) bothGroupsAtOnce = true;
      await tick(20);
      order.push(id);
      active.set(group, (active.get(group) ?? 1) - 1);
      return { action: "ACK", outcome: "X" };
    });

    consumer.start();
    await waitFor(() => order.length >= 4);
    await consumer.stop();

    expect(peakPerGroup).toBe(1);
    expect(bothGroupsAtOnce).toBe(true);
    expect(order.filter((id) => id.startsWith("a"))).toEqual(["a1", "a2", "a3"]);
  });

  test("retry no meio do grupo: o resto do grupo é devolvido sem ser processado", async () => {
    const fake = new FakeSqs([
      [message("a1", "A"), message("a2", "A"), message("a3", "A"), message("b1", "B")],
    ]);
    const handled: string[] = [];
    const consumer = build(fake, (m) => {
      const id = (JSON.parse(m.body) as { id: string }).id;
      handled.push(id);
      return id === "a1" ? { action: "RETRY", reason: "x" } : { action: "ACK", outcome: "X" };
    });

    consumer.start();
    await waitFor(() => fake.calls.length >= 4);
    await consumer.stop();

    expect(handled.sort()).toEqual(["a1", "b1"]); // a2 e a3 nem foram tentadas
    expect(fake.calls).toContainEqual({ type: "visibility", handle: "h-a1", seconds: 10 });
    expect(fake.calls).toContainEqual({ type: "visibility", handle: "h-a2", seconds: 0 });
    expect(fake.calls).toContainEqual({ type: "visibility", handle: "h-a3", seconds: 0 });
    expect(fake.calls).toContainEqual({ type: "delete", handle: "h-b1" });
  });

  test("DLQ que falha também para o grupo", async () => {
    const fake = new FakeSqs([[message("a1", "A"), message("a2", "A")]]);
    fake.failSend = true;
    const handled: string[] = [];
    const consumer = build(fake, (m) => {
      handled.push(m.body);
      return { action: "DEAD_LETTER", reason: "X" };
    });

    consumer.start();
    await waitFor(() => fake.calls.length >= 2);
    await consumer.stop();

    expect(handled).toHaveLength(1);
    expect(fake.calls).toContainEqual({ type: "visibility", handle: "h-a2", seconds: 0 });
  });
});

describe("resiliência do laço de poll", () => {
  test("erro ao receber não derruba o laço: tenta de novo e processa", async () => {
    const fake = new FakeSqs([new Error("SQS fora"), [message("a", "g1")]]);
    const consumer = build(fake, () => ({ action: "ACK", outcome: "X" }));

    consumer.start();
    await waitFor(() => fake.calls.length >= 1, 5_000);
    await consumer.stop();

    expect(kinds(fake)).toEqual(["delete:h-a"]);
  });

  test("start() duas vezes não duplica os laços", async () => {
    const fake = new FakeSqs([[message("a", "g1")]]);
    let handled = 0;
    const consumer = build(fake, () => {
      handled++;
      return { action: "ACK", outcome: "X" };
    });

    consumer.start();
    consumer.start();
    await waitFor(() => handled >= 1);
    await tick(50);
    await consumer.stop();

    expect(handled).toBe(1);
  });

  test("stop() sem start() e stop() repetido são inofensivos", async () => {
    const consumer = build(new FakeSqs([]), () => ({ action: "ACK", outcome: "X" }));

    await consumer.stop();
    consumer.start();
    await consumer.stop();
    await consumer.stop();
  });
});

describe("shutdown", () => {
  test("stop() espera a mensagem em andamento e devolve as não iniciadas do grupo", async () => {
    const fake = new FakeSqs([[message("a1", "A"), message("a2", "A"), message("b1", "B")]]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const consumer = build(fake, async () => {
      started++;
      await gate;
      return { action: "ACK", outcome: "X" };
    });

    consumer.start();
    await waitFor(() => started >= 2); // a1 e b1 em andamento
    let stopped = false;
    const stopping = consumer.stop().then(() => {
      stopped = true;
    });
    await tick(80);
    expect(stopped).toBe(false); // ainda esperando as em andamento
    release();
    await stopping;

    expect(fake.calls).toContainEqual({ type: "delete", handle: "h-a1" });
    expect(fake.calls).toContainEqual({ type: "delete", handle: "h-b1" });
    expect(fake.calls).toContainEqual({ type: "visibility", handle: "h-a2", seconds: 0 });
    expect(started).toBe(2); // a2 nunca foi iniciada
  });

  test("grace estourado: devolve à fila o que não terminou, sem esperar", async () => {
    const fake = new FakeSqs([[message("a1", "A")]]);
    let started = false;
    const consumer = build(
      fake,
      () => {
        started = true;
        return new Promise<Disposition>(() => {}); // pendurado
      },
      { shutdownGraceMs: 100 },
    );

    consumer.start();
    await waitFor(() => started);
    const before = Date.now();
    await consumer.stop();

    expect(Date.now() - before).toBeLessThan(1_500);
    expect(fake.calls).toContainEqual({ type: "visibility", handle: "h-a1", seconds: 0 });
    expect(fake.calls.some((c) => c.type === "delete")).toBe(false);
  });

  test("o abort interrompe o long poll na hora", async () => {
    const consumer = build(new FakeSqs([]), () => ({ action: "ACK", outcome: "X" }));

    consumer.start();
    await tick(20);
    const before = Date.now();
    await consumer.stop();

    expect(Date.now() - before).toBeLessThan(500);
  });
});

describe("visibilityBackoffSeconds", () => {
  test("base 0: reentrega imediata em qualquer tentativa", () => {
    for (const attempt of [1, 2, 5, 50]) expect(visibilityBackoffSeconds(attempt, 0)).toBe(0);
  });

  test("dobra a cada entrega até o teto de 2 minutos", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => visibilityBackoffSeconds(n, 2));
    expect(delays).toEqual([2, 4, 8, 16, 32, 64, 120, 120]);
  });

  test("arredonda para cima, em segundos inteiros, com jitter", () => {
    expect(visibilityBackoffSeconds(1, 2, 1.2)).toBe(3); // 2400 ms → 3 s
    expect(visibilityBackoffSeconds(1, 2, 0.8)).toBe(2); // 1600 ms → 2 s
    expect(Number.isInteger(visibilityBackoffSeconds(3, 3, 1.1))).toBe(true);
  });

  test("base maior que o teto padrão vira o próprio teto", () => {
    expect(visibilityBackoffSeconds(1, 600)).toBe(600);
    expect(visibilityBackoffSeconds(9, 600)).toBe(600);
  });

  test("contagem 0 ou negativa é tratada como a 1ª entrega", () => {
    expect(visibilityBackoffSeconds(0, 2)).toBe(2);
    expect(visibilityBackoffSeconds(-3, 2)).toBe(2);
  });

  test("nunca passa de 12 h (limite do SQS)", () => {
    expect(visibilityBackoffSeconds(40, 3_600)).toBeLessThanOrEqual(43_200);
  });
});
