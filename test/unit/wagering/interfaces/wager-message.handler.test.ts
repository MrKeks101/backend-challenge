import { describe, expect, test } from "bun:test";
import type { InboxRepository } from "../../../../src/messaging/application/ports/messaging-repositories";
import type { InboxMessage } from "../../../../src/messaging/domain";
import {
  type LogContext,
  RequestContext,
} from "../../../../src/shared/application/request-context";
import type {
  UnitOfWork,
  UnitOfWorkOptions,
} from "../../../../src/shared/application/unit-of-work";
import { InvalidArgumentError } from "../../../../src/shared/kernel";
import type {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from "../../../../src/wagering/application/process-wager-transaction.use-case";
import {
  FailureCode,
  InvalidWagerTransactionError,
  WagerTransactionKind,
} from "../../../../src/wagering/domain";
import {
  CONSUMER_NAME,
  MAX_RECEIVE_ATTEMPTS,
  WagerMessageHandler,
} from "../../../../src/wagering/interfaces/sqs/wager-message.handler";
import { WalletNotFoundError } from "../../../../src/wallet/application/errors";
import { makeMetrics, metricValue } from "../../../support/metrics";

/**
 * Decisões do handler (ack / retry / DLQ) com fakes de portas. O comportamento de ponta a ponta,
 * com PostgreSQL e SQS reais, está em test/integration/messaging.
 */
const WALLET = "0192f291-27dd-7d3f-8071-5f8685deef37";
const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";

const validMessage = (overrides: Record<string, unknown> = {}, messageId = "msg-1") => ({
  messageId,
  type: "WagerTransactionRequested",
  occurredAt: "2026-07-29T15:00:00.000Z",
  data: {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    idempotencyKey: "provider-a:transaction-123",
    playerId: PLAYER,
    walletId: WALLET,
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...overrides,
  },
});

const transient = (code = "57P03") => Object.assign(new Error("db"), { code });

class FakeInbox implements InboxRepository {
  rows = new Map<string, InboxMessage>();
  log: string[] = [];

  async tryReceive(message: InboxMessage): Promise<boolean> {
    this.log.push("tryReceive");
    const key = `${message.consumerName}/${message.messageId}`;
    if (this.rows.has(key)) return false;
    this.rows.set(key, message);
    return true;
  }
  async find(consumerName: string, messageId: string) {
    return this.rows.get(`${consumerName}/${messageId}`) ?? null;
  }
  async markProcessed() {
    this.log.push("markProcessed");
  }
}

function setup(
  options: {
    preflight?: () => Promise<void>;
    process?: (command: ProcessWagerTransactionCommand) => Promise<unknown>;
    recordFailure?: (code: FailureCode) => Promise<boolean>;
  } = {},
) {
  const inbox = new FakeInbox();
  const calls = {
    preflight: [] as ProcessWagerTransactionCommand[],
    process: [] as { command: ProcessWagerTransactionCommand; correlationId: string }[],
    recorded: [] as { code: FailureCode; command: ProcessWagerTransactionCommand }[],
    uowOptions: [] as (UnitOfWorkOptions | undefined)[],
  };
  const useCase = {
    preflight: async (command: ProcessWagerTransactionCommand) => {
      calls.preflight.push(command);
      await options.preflight?.();
    },
    processInTransaction: async (
      command: ProcessWagerTransactionCommand,
      context: { correlationId: string },
    ) => {
      inbox.log.push("process");
      calls.process.push({ command, correlationId: context.correlationId });
      return (
        (await options.process?.(command)) ?? {
          transaction: { status: "PROCESSED" },
          idempotentReplay: false,
        }
      );
    },
    recordFailure: async (command: ProcessWagerTransactionCommand, code: FailureCode) => {
      calls.recorded.push({ code, command });
      return (await options.recordFailure?.(code)) ?? true;
    },
  } as unknown as ProcessWagerTransactionUseCase;
  const uow: UnitOfWork = {
    run: async <T>(fn: () => Promise<T>, runOptions?: UnitOfWorkOptions) => {
      calls.uowOptions.push(runOptions);
      return fn();
    },
  };
  const metrics = makeMetrics();
  const handler = new WagerMessageHandler(
    useCase,
    uow,
    inbox,
    { now: () => new Date("2026-07-29T15:00:01.000Z") },
    metrics.wager,
  );
  return { handler, inbox, calls, metrics: metrics.app };
}

const handle = (h: WagerMessageHandler, body: unknown, receiveCount = 1) =>
  h.handle({ body: typeof body === "string" ? body : JSON.stringify(body), receiveCount });

describe("mensagem inválida", () => {
  test("não chega ao caso de uso nem à inbox", async () => {
    const { handler, calls, inbox } = setup();

    const result = await handle(handler, "isto não é json");

    expect(result).toEqual({
      action: "DEAD_LETTER",
      reason: "INVALID_MESSAGE",
      detail: "body is not valid JSON",
    });
    expect(calls.preflight).toEqual([]);
    expect(inbox.log).toEqual([]);
  });

  test("o detalhe cita caminho e código, nunca o valor recebido", async () => {
    const { handler } = setup();
    const message = validMessage({ roundId: 12345 });

    const result = await handle(handler, message);

    expect(result.action).toBe("DEAD_LETTER");
    if (result.action !== "DEAD_LETTER") return;
    expect(result.detail).toContain("data.roundId");
    expect(result.detail).not.toContain("12345");
  });
});

describe("caminho feliz", () => {
  test("preflight → inbox → caso de uso → marca processada, tudo numa transação com retry de conflito", async () => {
    const { handler, calls, inbox } = setup();

    const result = await handle(handler, validMessage());

    expect(result).toEqual({ action: "ACK", outcome: "PROCESSED" });
    expect(inbox.log).toEqual(["tryReceive", "process", "markProcessed"]);
    expect(calls.uowOptions).toEqual([{ retryOnConflict: 3 }]);
    expect(calls.preflight).toHaveLength(1);
  });

  test("a mensagem vira exatamente o comando do caso de uso (messageId é a correlação)", async () => {
    const { handler, calls } = setup();

    await handle(
      handler,
      validMessage({ referenceExternalTransactionId: "ref-1", kind: "REFUND" }),
    );

    expect(calls.process).toEqual([
      {
        correlationId: "msg-1",
        command: {
          idempotencyKey: "provider-a:transaction-123",
          providerId: "provider-a",
          externalTransactionId: "transaction-123",
          playerId: PLAYER,
          walletId: WALLET,
          roundId: "round-987",
          gameId: "fortune-chimp",
          kind: WagerTransactionKind.Refund,
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: "ref-1",
        },
      },
    ]);
  });

  test("a inbox usa o nome do consumidor e o hash do CONTEÚDO (não do messageId/occurredAt)", async () => {
    const { handler, inbox } = setup();
    await handle(handler, validMessage());
    const other = validMessage({}, "msg-2");
    other.occurredAt = "2030-01-01T00:00:00.000Z";
    await handle(handler, other);

    const [first, second] = [...inbox.rows.values()];
    expect(first?.consumerName).toBe(CONSUMER_NAME);
    expect(second?.payloadHash).toBe(first?.payloadHash as string);
    expect(first?.messageId).toBe("msg-1");
  });

  test("replay do caso de uso é reportado como REPLAY", async () => {
    const { handler } = setup({
      process: async () => ({ transaction: { status: "PROCESSED" }, idempotentReplay: true }),
    });

    expect(await handle(handler, validMessage())).toEqual({ action: "ACK", outcome: "REPLAY" });
  });

  test("REJECTED é desfecho de negócio: ack com o status", async () => {
    const { handler } = setup({
      process: async () => ({ transaction: { status: "REJECTED" }, idempotentReplay: false }),
    });

    expect(await handle(handler, validMessage())).toEqual({ action: "ACK", outcome: "REJECTED" });
  });
});

describe("deduplicação pela inbox", () => {
  test("mesma mensagem de novo: ACK DUPLICATE sem tocar no caso de uso", async () => {
    const { handler, calls } = setup();
    await handle(handler, validMessage());

    const again = await handle(handler, validMessage());

    expect(again).toEqual({ action: "ACK", outcome: "DUPLICATE" });
    expect(calls.process).toHaveLength(1);
  });

  test("mesmo messageId com conteúdo diferente: DLQ MESSAGE_PAYLOAD_MISMATCH", async () => {
    const { handler, calls } = setup();
    await handle(handler, validMessage());

    const tampered = await handle(
      handler,
      validMessage({ money: { amount: "99.00", currency: "BRL" } }),
    );

    expect(tampered).toMatchObject({ action: "DEAD_LETTER", reason: "MESSAGE_PAYLOAD_MISMATCH" });
    expect(calls.process).toHaveLength(1);
    expect(calls.recorded).toEqual([]); // anomalia do produtor: nada a auditar como FAILED
  });
});

describe("classificação de erros", () => {
  test.each([
    ["wallet inexistente", () => new WalletNotFoundError(), "WALLET_NOT_FOUND"],
    [
      "transação malformada",
      () => new InvalidWagerTransactionError("bad"),
      "INVALID_WAGER_TRANSACTION",
    ],
  ])("DomainError (%s) vai direto à DLQ, sem FAILED", async (_label, make, reason) => {
    const { handler, calls } = setup({
      preflight: async () => {
        throw make();
      },
    });

    const result = await handle(handler, validMessage());

    expect(result).toMatchObject({ action: "DEAD_LETTER", reason });
    expect(calls.recorded).toEqual([]);
    expect(calls.process).toEqual([]);
  });

  test("DomainError durante o processamento também é DLQ (conflito de idempotência etc.)", async () => {
    const { handler, calls } = setup({
      process: async () => {
        throw new WalletNotFoundError();
      },
    });

    expect(await handle(handler, validMessage())).toMatchObject({
      action: "DEAD_LETTER",
      reason: "WALLET_NOT_FOUND",
    });
    expect(calls.recorded).toEqual([]);
  });

  test.each([1, 2, 3, 4])("transitório na entrega %i: RETRY", async (receiveCount) => {
    const { handler, calls } = setup({
      process: async () => {
        throw transient();
      },
    });

    const result = await handle(handler, validMessage(), receiveCount);

    expect(result).toEqual({ action: "RETRY", reason: "cannot_connect_now" });
    expect(calls.recorded).toEqual([]);
  });

  test("transitório na última entrega: grava FAILED(PROCESSING_RETRIES_EXHAUSTED) e vai à DLQ", async () => {
    const { handler, calls } = setup({
      process: async () => {
        throw transient();
      },
    });

    const result = await handle(handler, validMessage(), MAX_RECEIVE_ATTEMPTS);

    expect(result).toEqual({
      action: "DEAD_LETTER",
      reason: "PROCESSING_RETRIES_EXHAUSTED",
      detail: "cannot_connect_now",
    });
    expect(calls.recorded.map((r) => r.code)).toEqual([FailureCode.ProcessingRetriesExhausted]);
    expect(calls.recorded[0]?.command.idempotencyKey).toBe("provider-a:transaction-123");
  });

  test("além do limite (entrega 9) continua sendo DLQ, nunca RETRY", async () => {
    const { handler } = setup({
      process: async () => {
        throw transient();
      },
    });

    expect(await handle(handler, validMessage(), 9)).toMatchObject({
      action: "DEAD_LETTER",
      reason: "PROCESSING_RETRIES_EXHAUSTED",
    });
  });

  test.each([
    ["bug sem código", () => new TypeError("boom"), "unclassified"],
    [
      "violação de constraint",
      () => Object.assign(new Error("x"), { code: "23514" }),
      "sqlstate_23514",
    ],
    ["dado inválido", () => Object.assign(new Error("x"), { code: "22P02" }), "sqlstate_22P02"],
  ])(
    "permanente (%s): DLQ já na 1ª entrega + FAILED(INTERNAL_PERMANENT_ERROR)",
    async (_l, make, detail) => {
      const { handler, calls } = setup({
        process: async () => {
          throw make();
        },
      });

      const result = await handle(handler, validMessage(), 1);

      expect(result).toEqual({ action: "DEAD_LETTER", reason: "INTERNAL_PERMANENT_ERROR", detail });
      expect(calls.recorded.map((r) => r.code)).toEqual([FailureCode.InternalPermanentError]);
    },
  );

  test("argumento inválido do kernel é DomainError: DLQ pelo código, sem FAILED", async () => {
    const { handler, calls } = setup({
      process: async () => {
        throw new InvalidArgumentError("x");
      },
    });

    expect(await handle(handler, validMessage())).toMatchObject({
      action: "DEAD_LETTER",
      reason: "INVALID_ARGUMENT",
    });
    expect(calls.recorded).toEqual([]);
  });

  test("se registrar o FAILED também falha, a DLQ continua sendo o desfecho", async () => {
    const { handler } = setup({
      process: async () => {
        throw new TypeError("boom");
      },
      recordFailure: async () => {
        throw transient();
      },
    });

    expect(await handle(handler, validMessage())).toMatchObject({
      action: "DEAD_LETTER",
      reason: "INTERNAL_PERMANENT_ERROR",
    });
  });

  test("OptimisticLockError é transitório", async () => {
    const { OptimisticLockError } = await import(
      "../../../../src/shared/infrastructure/persistence/errors"
    );
    const { handler } = setup({
      process: async () => {
        throw new OptimisticLockError("wallet");
      },
    });

    expect(await handle(handler, validMessage(), 1)).toMatchObject({ action: "RETRY" });
  });
});

describe("contexto de log (correlationId via AsyncLocalStorage)", () => {
  test("o caso de uso roda com messageId como correlationId e os ids da mensagem", async () => {
    let seen: Readonly<LogContext> = {};
    const { handler } = setup({
      process: async () => {
        seen = { ...RequestContext.current() };
        return { transaction: { status: "PROCESSED" }, idempotentReplay: false };
      },
    });

    await handle(handler, validMessage({}, "msg-42"));

    expect(seen).toEqual({
      correlationId: "msg-42",
      messageId: "msg-42",
      walletId: WALLET,
      providerId: "provider-a",
    });
  });

  test("o contexto não vaza para fora do handler nem entre mensagens simultâneas", async () => {
    const seen: string[] = [];
    const { handler } = setup({
      process: async (command) => {
        await new Promise((resolve) =>
          setTimeout(resolve, command.externalTransactionId === "t-1" ? 20 : 1),
        );
        seen.push(`${command.externalTransactionId}=${RequestContext.current().messageId}`);
        return { transaction: { status: "PROCESSED" }, idempotentReplay: false };
      },
    });

    await Promise.all([
      handle(handler, validMessage({ externalTransactionId: "t-1", idempotencyKey: "k1" }, "m-1")),
      handle(handler, validMessage({ externalTransactionId: "t-2", idempotencyKey: "k2" }, "m-2")),
    ]);

    expect(seen.sort()).toEqual(["t-1=m-1", "t-2=m-2"]);
    expect(RequestContext.current()).toEqual({});
  });
});

describe("métricas", () => {
  test("PROCESSED conta a transação por status e tipo e mede a latência (sqs)", async () => {
    const { handler, metrics } = setup();

    await handle(handler, validMessage());

    expect(
      await metricValue(metrics, "wager_transactions_total", { status: "PROCESSED", kind: "BET" }),
    ).toBe(1);
    expect(
      await metricValue(metrics, "wager_processing_duration_seconds_count", { source: "sqs" }),
    ).toBe(1);
  });

  test("mensagem repetida conta duplicata da inbox, não uma nova transação", async () => {
    const { handler, metrics } = setup();

    await handle(handler, validMessage());
    await handle(handler, validMessage());

    expect(await metricValue(metrics, "wager_duplicates_total", { source: "inbox" })).toBe(1);
    expect(await metricValue(metrics, "wager_transactions_total")).toBe(1);
  });

  test("replay da idempotency key conta duplicata `replay`", async () => {
    const { handler, metrics } = setup({
      process: async () => ({ transaction: { status: "PROCESSED" }, idempotentReplay: true }),
    });

    await handle(handler, validMessage());

    expect(await metricValue(metrics, "wager_duplicates_total", { source: "replay" })).toBe(1);
    expect(await metricValue(metrics, "wager_transactions_total")).toBe(0);
  });

  test("falha permanente gravada conta FAILED; retry e DLQ não contam transação", async () => {
    const failing = setup({
      process: async () => {
        throw new TypeError("boom");
      },
    });
    await handle(failing.handler, validMessage());
    expect(
      await metricValue(failing.metrics, "wager_transactions_total", { status: "FAILED" }),
    ).toBe(1);

    const retrying = setup({
      process: async () => {
        throw transient();
      },
    });
    await handle(retrying.handler, validMessage(), 1);
    expect(await metricValue(retrying.metrics, "wager_transactions_total")).toBe(0);
  });

  test("se o FAILED não foi gravado (já existia), não conta", async () => {
    const { handler, metrics } = setup({
      process: async () => {
        throw new TypeError("boom");
      },
      recordFailure: async () => false,
    });

    await handle(handler, validMessage());

    expect(await metricValue(metrics, "wager_transactions_total")).toBe(0);
  });
});
