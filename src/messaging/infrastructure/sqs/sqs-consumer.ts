import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { Logger } from "@nestjs/common";
import { backoffDelayMs } from "../../../shared/kernel";
import type { Disposition, MessageHandler } from "../../application/ports/message-handler";
import type { QueueRegistry } from "./sqs.module";

export interface ConsumerConfig {
  /** Laços de long poll independentes. O FIFO nunca entrega o mesmo grupo a dois ao mesmo tempo. */
  pollers: number;
  /** `MaxNumberOfMessages` (1–10). */
  batchSize: number;
  /** `WaitTimeSeconds` do long poll (0–20). */
  waitSeconds: number;
  /** Quanto o `stop()` espera as mensagens em andamento antes de devolvê-las à fila. */
  shutdownGraceMs: number;
  /** Segundos de invisibilidade antes da próxima entrega, dado `ApproximateReceiveCount`. */
  retryDelaySeconds: (receiveCount: number) => number;
}

const MAX_VISIBILITY_SECONDS = 43_200; // limite do SQS: 12 h
const RETRY_CAP_MS = 120_000;
const MAX_ERROR_PAUSE_MS = 10_000;
const MAX_ATTRIBUTE_LENGTH = 500;

/**
 * Backoff de visibilidade (RF-SQS-06): `base * 2^(tentativa-1)` com teto de 2 min e jitter. Base
 * zero devolve sempre 0 (reentrega imediata), útil em teste e em filas de baixa latência.
 */
export function visibilityBackoffSeconds(
  receiveCount: number,
  baseSeconds: number,
  jitter = 1,
): number {
  if (baseSeconds <= 0) return 0;
  const baseMs = baseSeconds * 1000;
  const delayMs = backoffDelayMs(
    Math.max(1, receiveCount),
    { baseMs, capMs: Math.max(baseMs, RETRY_CAP_MS) },
    jitter,
  );
  return Math.min(MAX_VISIBILITY_SECONDS, Math.ceil(delayMs / 1000));
}

/**
 * Consumidor da fila de entrada (ARCHITECTURE §11). Recebe em lote, processa grupos diferentes em
 * paralelo e as mensagens do MESMO grupo em série e em ordem. O `ack` (delete) só vem depois que o
 * handler devolve `ACK`, ou seja, depois do commit.
 *
 * Quando uma mensagem de um grupo precisa de retry, o resto daquele grupo no lote é devolvido à
 * fila sem ser processado: processá-lo à frente dela quebraria a ordem.
 */
export class SqsConsumer {
  private readonly logger = new Logger("SqsConsumer");
  private running = false;
  private abort = new AbortController();
  private pollers: Promise<void>[] = [];
  private readonly sleepers = new Set<() => void>();
  /** Mensagens recebidas e ainda sem desfecho: o que `stop()` devolve se a espera estourar. */
  private readonly unsettled = new Map<string, { queueUrl: string }>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueRegistry,
    private readonly handler: MessageHandler,
    private readonly config: ConsumerConfig,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.pollers = Array.from({ length: this.config.pollers }, () => this.pollLoop());
  }

  /**
   * Para de receber, deixa as mensagens em andamento terminarem (até `shutdownGraceMs`) e devolve
   * à fila, com visibilidade 0, as que não terminaram (RF-SQS-08).
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    for (const wake of this.sleepers) wake();

    const finished = Promise.allSettled(this.pollers).then(() => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.config.shutdownGraceMs);
    });
    const completed = await Promise.race([finished, expired]);
    clearTimeout(timer);

    if (!completed) {
      this.logger.warn({ event: "consumer_shutdown_grace_expired", pending: this.unsettled.size });
      await Promise.allSettled(
        [...this.unsettled.entries()].map(([handle, { queueUrl }]) =>
          this.release(queueUrl, handle),
        ),
      );
    }
    this.pollers = [];
  }

  private async pollLoop(): Promise<void> {
    let consecutiveErrors = 0;
    while (this.running) {
      try {
        const { transactions, transactionsDlq } = await this.queues.ensure();
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: transactions,
            MaxNumberOfMessages: this.config.batchSize,
            WaitTimeSeconds: this.config.waitSeconds,
            MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
          }),
          { abortSignal: this.abort.signal },
        );
        consecutiveErrors = 0;
        const messages = response.Messages ?? [];
        if (messages.length > 0) await this.processBatch(transactions, transactionsDlq, messages);
      } catch (error) {
        if (!this.running) return; // abortado pelo stop()
        consecutiveErrors++;
        this.logger.error({
          event: "consumer_poll_error",
          error: error instanceof Error ? error.name : typeof error,
          consecutiveErrors,
        });
        await this.sleep(Math.min(500 * consecutiveErrors, MAX_ERROR_PAUSE_MS));
      }
    }
  }

  private async processBatch(queueUrl: string, dlqUrl: string, messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      if (message.ReceiptHandle) this.unsettled.set(message.ReceiptHandle, { queueUrl });
      const key = message.Attributes?.MessageGroupId ?? message.MessageId ?? "";
      groups.set(key, [...(groups.get(key) ?? []), message]);
    }
    await Promise.all(
      [...groups.entries()].map(([groupId, group]) =>
        this.processGroup(queueUrl, dlqUrl, groupId, group),
      ),
    );
  }

  /** Em série e em ordem; ao primeiro retry/falha o resto do grupo volta à fila intacto. */
  private async processGroup(
    queueUrl: string,
    dlqUrl: string,
    groupId: string,
    group: Message[],
  ): Promise<void> {
    let halted = false;
    for (const message of group) {
      const handle = message.ReceiptHandle;
      if (!handle) continue;
      if (halted || !this.running) {
        await this.release(queueUrl, handle);
        continue;
      }
      const raw = message.Attributes?.ApproximateReceiveCount ?? "1";
      const parsed = Number.parseInt(raw, 10); // allow-number: contador de entregas do SQS
      const receiveCount = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
      const disposition = await this.handle(message, receiveCount);
      const proceed = await this.settle(
        queueUrl,
        dlqUrl,
        groupId,
        message,
        receiveCount,
        disposition,
      );
      this.unsettled.delete(handle);
      if (!proceed) halted = true;
    }
  }

  private async handle(message: Message, receiveCount: number): Promise<Disposition> {
    try {
      return await this.handler.handle({ body: message.Body ?? "", receiveCount });
    } catch (error) {
      // O handler promete não lançar; se lançar é bug, e retry é o desfecho seguro.
      this.logger.error({
        event: "handler_threw",
        error: error instanceof Error ? error.name : typeof error,
      });
      return { action: "RETRY", reason: "handler_threw" };
    }
  }

  /** Aplica a `Disposition`. Devolve `false` se o grupo deve parar (a mensagem não foi concluída). */
  private async settle(
    queueUrl: string,
    dlqUrl: string,
    groupId: string,
    message: Message,
    receiveCount: number,
    disposition: Disposition,
  ): Promise<boolean> {
    const handle = message.ReceiptHandle as string;

    if (disposition.action === "ACK") {
      await this.delete(queueUrl, handle);
      return true;
    }

    if (disposition.action === "DEAD_LETTER") {
      try {
        await this.sendToDlq(dlqUrl, groupId, message, receiveCount, disposition);
      } catch (error) {
        // Sem DLQ não se apaga o original: ele volta depois do backoff e tenta de novo.
        this.logger.error({
          event: "dlq_send_failed",
          error: error instanceof Error ? error.name : typeof error,
        });
        await this.delay(queueUrl, handle, receiveCount);
        return false;
      }
      await this.delete(queueUrl, handle);
      return true;
    }

    await this.delay(queueUrl, handle, receiveCount);
    return false;
  }

  private async sendToDlq(
    dlqUrl: string,
    groupId: string,
    message: Message,
    receiveCount: number,
    disposition: Extract<Disposition, { action: "DEAD_LETTER" }>,
  ): Promise<void> {
    const attribute = (value: string) => ({
      DataType: "String",
      StringValue: value.slice(0, MAX_ATTRIBUTE_LENGTH),
    });
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body ?? "",
        MessageGroupId: groupId,
        MessageDeduplicationId: message.MessageId ?? `${groupId}-${Date.now()}`,
        MessageAttributes: {
          errorReason: attribute(disposition.reason),
          errorDetail: attribute(disposition.detail ?? ""),
          originalMessageId: attribute(message.MessageId ?? ""),
          receiveCount: { DataType: "Number", StringValue: String(receiveCount) },
          failedAt: attribute(new Date().toISOString()),
        },
      }),
    );
  }

  private async delete(queueUrl: string, receiptHandle: string): Promise<void> {
    try {
      await this.sqs.send(
        new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
      );
    } catch (error) {
      // O efeito já está commitado. Sem o delete a mensagem volta, e a inbox absorve a duplicata.
      this.logger.warn({
        event: "ack_failed",
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private async delay(
    queueUrl: string,
    receiptHandle: string,
    receiveCount: number,
  ): Promise<void> {
    await this.changeVisibility(
      queueUrl,
      receiptHandle,
      this.config.retryDelaySeconds(receiveCount),
    );
  }

  private release(queueUrl: string, receiptHandle: string): Promise<void> {
    return this.changeVisibility(queueUrl, receiptHandle, 0).finally(() => {
      this.unsettled.delete(receiptHandle);
    });
  }

  private async changeVisibility(
    queueUrl: string,
    receiptHandle: string,
    seconds: number,
  ): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      this.logger.warn({
        event: "visibility_change_failed",
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.sleepers.add(done);
    });
  }
}
