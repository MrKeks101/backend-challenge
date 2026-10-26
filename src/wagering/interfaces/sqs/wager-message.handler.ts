import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  Disposition,
  IncomingMessage,
  MessageHandler,
} from "../../../messaging/application/ports/message-handler";
import {
  INBOX_REPOSITORY,
  type InboxRepository,
} from "../../../messaging/application/ports/messaging-repositories";
import { InboxMessage, MessagePayloadMismatchError } from "../../../messaging/domain";
import { RequestContext } from "../../../shared/application/request-context";
import { CLOCK } from "../../../shared/application/tokens";
import { UNIT_OF_WORK, type UnitOfWork } from "../../../shared/application/unit-of-work";
import { classifyError } from "../../../shared/infrastructure/persistence/error-classifier";
import { type Clock, DomainError, hashCanonical } from "../../../shared/kernel";
import { WAGER_METRICS, type WagerMetrics } from "../../application/ports/wager-metrics";
import {
  type ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from "../../application/process-wager-transaction.use-case";
import { FailureCode } from "../../domain";
import { parseWagerMessage, type WagerRequestedMessage } from "./wager-message.schema";

export const CONSUMER_NAME = "wager-transactions-consumer";

/** Tentativas de recebimento (SQS) a partir das quais o erro transitório vira falha permanente. */
export const MAX_RECEIVE_ATTEMPTS = 5;
const CONFLICT_RETRIES = 3;

/**
 * Adaptador SQS → caso de uso (RF-SQS-03, AR-50): é a MESMA função que a API HTTP chama. Cuida do
 * que é próprio da fila: validar a mensagem, deduplicar pela inbox NA MESMA transação do efeito e
 * classificar o desfecho (ack / retry / DLQ). O `ack` só acontece depois do commit (AR-44).
 */
@Injectable()
export class WagerMessageHandler implements MessageHandler {
  private readonly logger = new Logger("WagerMessageHandler");

  constructor(
    @Inject(ProcessWagerTransactionUseCase)
    private readonly useCase: ProcessWagerTransactionUseCase,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(INBOX_REPOSITORY) private readonly inbox: InboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WAGER_METRICS) private readonly metrics: WagerMetrics,
  ) {}

  async handle({ body, receiveCount }: IncomingMessage): Promise<Disposition> {
    const parsed = parseWagerMessage(body);
    if (!parsed.ok) {
      return { action: "DEAD_LETTER", reason: "INVALID_MESSAGE", detail: parsed.detail };
    }
    const { message } = parsed;
    const command = toCommand(message);

    // Tudo o que roda daqui (logs, eventos) carrega o id da mensagem como correlationId.
    return RequestContext.run(
      {
        correlationId: message.messageId,
        messageId: message.messageId,
        walletId: command.walletId,
        providerId: command.providerId,
      },
      () => this.process(message, command, receiveCount),
    );
  }

  private async process(
    message: WagerRequestedMessage,
    command: ProcessWagerTransactionCommand,
    receiveCount: number,
  ): Promise<Disposition> {
    const started = performance.now();
    try {
      await this.useCase.preflight(command);
      const outcome = await this.uow.run(() => this.processOnce(message, command), {
        retryOnConflict: CONFLICT_RETRIES,
      });
      this.countOutcome(outcome, command, (performance.now() - started) / 1000);
      return { action: "ACK", outcome };
    } catch (error) {
      return this.dispose(error, message, command, receiveCount);
    }
  }

  /** Depois do commit. `DUPLICATE` = inbox; `REPLAY` = mesma idempotency key já processada. */
  private countOutcome(
    outcome: string,
    command: ProcessWagerTransactionCommand,
    seconds: number,
  ): void {
    if (outcome === "DUPLICATE") this.metrics.duplicate("inbox");
    else if (outcome === "REPLAY") this.metrics.duplicate("replay");
    else this.metrics.transactionResolved(outcome, command.kind);
    this.metrics.observeProcessing("sqs", seconds);
  }

  /** Inbox + efeito financeiro + marca de processada: uma só transação SQL. */
  private async processOnce(
    message: WagerRequestedMessage,
    command: ProcessWagerTransactionCommand,
  ): Promise<string> {
    const now = this.clock.now();
    const payloadHash = hashCanonical(message.data);
    const received = InboxMessage.receive({
      messageId: message.messageId,
      consumerName: CONSUMER_NAME,
      payloadHash,
      receivedAt: now,
    });

    if (!(await this.inbox.tryReceive(received))) {
      // A linha só existe se a transação que a criou commitou por inteiro: já foi processada.
      const existing = await this.inbox.find(CONSUMER_NAME, message.messageId);
      if (existing && !existing.matchesPayload(payloadHash))
        throw new MessagePayloadMismatchError();
      return "DUPLICATE";
    }

    const result = await this.useCase.processInTransaction(command, {
      correlationId: message.messageId,
    });
    received.markProcessed(now);
    await this.inbox.markProcessed(received);
    return result.idempotentReplay ? "REPLAY" : result.transaction.status;
  }

  private async dispose(
    error: unknown,
    message: WagerRequestedMessage,
    command: ProcessWagerTransactionCommand,
    receiveCount: number,
  ): Promise<Disposition> {
    const { kind, reason } = classifyError(error);

    // Entrada contraditória (payload divergente, conflito de idempotência, wallet inexistente,
    // transação malformada): reenviar não muda nada, e não há o que auditar como FAILED.
    if (error instanceof DomainError) {
      return { action: "DEAD_LETTER", reason: error.code, detail: error.message };
    }

    if (kind === "TRANSIENT") {
      if (receiveCount < MAX_RECEIVE_ATTEMPTS) return { action: "RETRY", reason };
      await this.recordFailure(message, command, FailureCode.ProcessingRetriesExhausted);
      return { action: "DEAD_LETTER", reason: "PROCESSING_RETRIES_EXHAUSTED", detail: reason };
    }

    await this.recordFailure(message, command, FailureCode.InternalPermanentError);
    return { action: "DEAD_LETTER", reason: "INTERNAL_PERMANENT_ERROR", detail: reason };
  }

  /** Best-effort: se o banco ainda estiver ruim, a mensagem vai para a DLQ do mesmo jeito. */
  private async recordFailure(
    message: WagerRequestedMessage,
    command: ProcessWagerTransactionCommand,
    code: FailureCode,
  ): Promise<void> {
    try {
      const recorded = await this.useCase.recordFailure(command, code, {
        correlationId: message.messageId,
      });
      if (recorded) this.metrics.transactionResolved("FAILED", command.kind);
    } catch (error) {
      this.logger.warn({
        event: "record_failure_skipped",
        code,
        reason: classifyError(error).reason,
      });
    }
  }
}

function toCommand(message: WagerRequestedMessage): ProcessWagerTransactionCommand {
  const { data } = message;
  return {
    idempotencyKey: data.idempotencyKey,
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    playerId: data.playerId,
    walletId: data.walletId,
    roundId: data.roundId,
    gameId: data.gameId,
    kind: data.kind,
    money: data.money,
    referenceExternalTransactionId: data.referenceExternalTransactionId,
  };
}
