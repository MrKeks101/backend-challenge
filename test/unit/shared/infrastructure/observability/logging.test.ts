import { describe, expect, test } from "bun:test";
import { Logger } from "@nestjs/common";
import { RequestContext } from "../../../../../src/shared/application/request-context";
import {
  AppLogger,
  createPinoLogger,
} from "../../../../../src/shared/infrastructure/observability/app-logger";
import {
  REDACTED,
  sanitizeForLog,
} from "../../../../../src/shared/infrastructure/observability/log-sanitizer";
import { brl } from "../../../../support/money";

/** Logger real (pino) escrevendo numa lista: cada linha tem de ser um JSON válido. */
function capture(level = "debug") {
  const lines: string[] = [];
  const logger = new AppLogger(
    createPinoLogger({ level, destination: { write: (chunk: string) => void lines.push(chunk) } }),
  );
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, parsed };
}

describe("sanitizeForLog (AR-55)", () => {
  test("troca campos financeiros e payloads por [REDACTED], em qualquer profundidade", () => {
    const result = sanitizeForLog({
      event: "x",
      amount: "25.00",
      nested: { balance: "100.00", observedBalance: "75.00", deeper: [{ money: brl("1.00") }] },
      payload: { any: "thing" },
      body: "raw",
      Authorization: "Bearer abc",
      walletId: "w-1",
    });

    expect(result).toEqual({
      event: "x",
      amount: REDACTED,
      nested: { balance: REDACTED, observedBalance: REDACTED, deeper: [{ money: REDACTED }] },
      payload: REDACTED,
      body: REDACTED,
      Authorization: REDACTED,
      walletId: "w-1",
    });
  });

  test.each([
    "amount",
    "Amount",
    "balance",
    "storedBalance",
    "calculatedBalance",
    "balanceAfter",
    "difference",
    "money",
    "payload",
    "body",
    "password",
    "secret",
    "token",
    "cookie",
  ])("chave sensível %s", (key) => {
    expect(sanitizeForLog({ [key]: "12.34" })).toEqual({ [key]: REDACTED });
  });

  test("ids e campos operacionais passam intactos", () => {
    const fields = {
      event: "http_request",
      correlationId: "c-1",
      messageId: "m-1",
      transactionId: "t-1",
      walletId: "w-1",
      providerId: "p-1",
      status: 201,
      durationMs: 12,
      kind: "BET",
      failureCode: "INSUFFICIENT_FUNDS",
    };
    expect(sanitizeForLog(fields)).toEqual(fields);
  });

  test("erro vira name/code: a mensagem pode trazer a linha do banco", () => {
    const error = Object.assign(new Error("duplicate key (balance)=(100.00)"), { code: "23505" });
    expect(sanitizeForLog({ error })).toEqual({ error: { name: "Error", code: "23505" } });
  });

  test("não quebra com ciclo, bigint, Date, null e undefined", () => {
    const cyclic: Record<string, unknown> = { id: "a" };
    cyclic.self = cyclic;
    const result = sanitizeForLog({
      cyclic,
      big: 10n,
      at: new Date("2026-01-01T00:00:00.000Z"),
      none: null,
      missing: undefined,
    }) as Record<string, unknown>;
    expect(result.big).toBe("10");
    expect(result.at).toBe("2026-01-01T00:00:00.000Z");
    expect(result.none).toBeNull();
    expect(JSON.stringify(result)).toContain("[TRUNCATED]");
  });

  test("não altera o objeto original", () => {
    const original = { amount: "1.00", nested: { balance: "2.00" } };
    sanitizeForLog(original);
    expect(original).toEqual({ amount: "1.00", nested: { balance: "2.00" } });
  });
});

describe("AppLogger (pino)", () => {
  test("cada linha é JSON com nível, hora ISO e o texto", () => {
    const { logger, parsed } = capture();

    logger.log("hello", "Ctx");

    expect(parsed()).toEqual([
      expect.objectContaining({ level: "info", msg: "hello", context: "Ctx" }),
    ]);
    expect(new Date(String(parsed()[0]?.time)).toISOString()).toBe(parsed()[0]?.time as string);
  });

  test("objeto vira campos do JSON, com o contexto do Logger do Nest", () => {
    const { logger, parsed } = capture();

    logger.warn(
      { event: "reconciliation_divergence", walletId: "w-1", checkedEntries: 3 },
      "Reconciliation",
    );

    expect(parsed()[0]).toMatchObject({
      level: "warn",
      event: "reconciliation_divergence",
      walletId: "w-1",
      checkedEntries: 3,
      context: "Reconciliation",
    });
  });

  test("o RequestContext entra em todo log: correlationId, messageId, transactionId, walletId, providerId", () => {
    const { logger, parsed } = capture();

    RequestContext.run(
      { correlationId: "corr-1", messageId: "msg-1", providerId: "prov-1" },
      () => {
        RequestContext.enrich({ transactionId: "tx-1", walletId: "wal-1" });
        logger.log({ event: "something" });
      },
    );

    expect(parsed()[0]).toMatchObject({
      event: "something",
      correlationId: "corr-1",
      messageId: "msg-1",
      transactionId: "tx-1",
      walletId: "wal-1",
      providerId: "prov-1",
    });
  });

  test("fora de uma requisição não inventa ids", () => {
    const { logger, parsed } = capture();

    logger.log({ event: "background" });

    expect(parsed()[0]).not.toHaveProperty("correlationId");
  });

  test("log não contém amount, balance nem payload, mesmo se o chamador passar", () => {
    const { logger, lines } = capture();

    logger.error({
      event: "oops",
      amount: "25.00",
      balance: "100.00",
      money: brl("25.00"),
      payload: { money: { amount: "25.00", currency: "BRL" } },
      error: Object.assign(new Error("row (balance)=(100.00)"), { code: "23505" }),
    });
    logger.log("texto solto");

    const output = lines.join("");
    expect(output).not.toContain("25.00");
    expect(output).not.toContain("100.00");
    expect(output).toContain(REDACTED);
    expect(output).toContain("23505");
  });

  test("o `new Logger()` do Nest chega até o pino quando instalado com useLogger", () => {
    const { logger, parsed } = capture();
    Logger.overrideLogger(logger);
    try {
      new Logger("Http").warn({ event: "via_nest", status: 500 });
    } finally {
      Logger.overrideLogger(false);
    }

    expect(parsed()[0]).toMatchObject({
      level: "warn",
      event: "via_nest",
      status: 500,
      context: "Http",
    });
  });

  test("respeita o nível configurado", () => {
    const { logger, lines } = capture("warn");

    logger.log("info some");
    logger.debug("debug some");
    logger.warn("warn some");

    expect(lines).toHaveLength(1);
  });

  test("stack de erro do Nest não é escrito", () => {
    const { logger, lines } = capture();

    logger.error("falhou", "Error: x\n    at secret (file.ts:1:1)", "Ctx");

    expect(lines.join("")).not.toContain("secret");
  });
});

describe("RequestContext", () => {
  test("isola contextos concorrentes (AsyncLocalStorage)", async () => {
    const seen: string[] = [];
    await Promise.all(
      ["a", "b", "c"].map((id, index) =>
        RequestContext.run({ correlationId: id }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 10 - index * 3));
          RequestContext.enrich({ walletId: `w-${id}` });
          await new Promise((resolve) => setTimeout(resolve, 1));
          seen.push(
            `${RequestContext.current().correlationId}/${RequestContext.current().walletId}`,
          );
        }),
      ),
    );

    expect(seen.sort()).toEqual(["a/w-a", "b/w-b", "c/w-c"]);
    expect(RequestContext.current()).toEqual({});
  });

  test("enrich sem contexto aberto é inofensivo e não vaza para o próximo", () => {
    RequestContext.enrich({ walletId: "stray" });

    expect(RequestContext.current()).toEqual({});
  });

  test("enrich ignora undefined (não apaga o que já existe)", () => {
    RequestContext.run({ correlationId: "c" }, () => {
      RequestContext.enrich({ correlationId: undefined, walletId: "w" });
      expect(RequestContext.current()).toEqual({ correlationId: "c", walletId: "w" });
    });
  });
});
