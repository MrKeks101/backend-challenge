import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { SQS_CLIENT } from "../../src/messaging/infrastructure/sqs/sqs.module";
import { ProcessWagerTransactionUseCase } from "../../src/wagering/application/process-wager-transaction.use-case";
import type { ConsumerHarness } from "./consumer";

/** Erro com SQLSTATE/código de rede, como os que o driver produz. */
export const pgError = (code: string): Error => Object.assign(new Error("injected"), { code });

/**
 * Injeta falha no caso de uso REAL do app: antes de delegar ao `processInTransaction` verdadeiro,
 * `fail(n)` decide (n = nº da chamada) se lança. Banco e SQS continuam reais.
 */
export function injectFailure(
  harness: ConsumerHarness,
  fail: (
    call: number,
    args: Parameters<ProcessWagerTransactionUseCase["processInTransaction"]>,
  ) => Error | null,
) {
  const useCase = harness.api.app.get(ProcessWagerTransactionUseCase);
  const original = useCase.processInTransaction.bind(useCase);
  let calls = 0;
  useCase.processInTransaction = async (...args) => {
    const error = fail(++calls, args);
    if (error) throw error;
    return original(...args);
  };
  return {
    calls: () => calls,
    restore: () => {
      useCase.processInTransaction = original;
    },
  };
}

/**
 * Simula "o worker morreu depois do commit e antes do ack": o 1º `DeleteMessage` do consumidor
 * não chega ao SQS; no lugar dele a mensagem é devolvida (visibilidade 0) para ser reentregue.
 */
export function dropFirstAck(harness: ConsumerHarness) {
  const sqs = harness.api.app.get<SQSClient>(SQS_CLIENT, { strict: false });
  const original = sqs.send.bind(sqs) as (command: unknown, options?: unknown) => Promise<unknown>;
  let dropped = 0;
  (sqs as unknown as { send: typeof original }).send = (command, options) => {
    if (command instanceof DeleteMessageCommand && dropped === 0) {
      dropped++;
      const { QueueUrl, ReceiptHandle } = command.input;
      return original(
        new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle, VisibilityTimeout: 0 }),
        options,
      );
    }
    return original(command, options);
  };
  return { count: () => dropped };
}
