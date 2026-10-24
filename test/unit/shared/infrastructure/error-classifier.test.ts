import { describe, expect, test } from "bun:test";
import {
  classifyError,
  isTransient,
} from "../../../../src/shared/infrastructure/persistence/error-classifier";
import { OptimisticLockError } from "../../../../src/shared/infrastructure/persistence/errors";
import { InvalidMoneyError } from "../../../../src/shared/kernel";
import { InsufficientFundsError } from "../../../../src/wallet/domain";

const pg = (code: string, extra: object = {}) => Object.assign(new Error("pg"), { code, ...extra });

describe("classifyError", () => {
  test("DomainError é BUSINESS e o motivo é o code", () => {
    expect(classifyError(new InsufficientFundsError())).toEqual({
      kind: "BUSINESS",
      reason: "INSUFFICIENT_FUNDS",
    });
    expect(classifyError(new InvalidMoneyError("x")).kind).toBe("BUSINESS");
  });

  test("OptimisticLockError é TRANSIENT (recarregar e tentar de novo)", () => {
    expect(classifyError(new OptimisticLockError("w")).kind).toBe("TRANSIENT");
  });

  test.each([
    ["40001", "serialization_failure"],
    ["40P01", "deadlock_detected"],
    ["55P03", "lock_not_available"],
    ["57014", "query_canceled"],
    ["57P01", "admin_shutdown"],
    ["53300", "too_many_connections"],
    ["53100", "disk_full"],
  ])("SQLSTATE %s → TRANSIENT (%s)", (code, reason) => {
    expect(classifyError(pg(code))).toEqual({ kind: "TRANSIENT", reason, sqlState: code });
  });

  test.each(["08000", "08003", "08006", "08001"])("classe 08 (%s) → TRANSIENT", (code) => {
    expect(classifyError(pg(code))).toMatchObject({
      kind: "TRANSIENT",
      reason: "connection_exception",
    });
  });

  test.each(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND"])(
    "falha de rede %s → TRANSIENT",
    (code) => {
      expect(classifyError(pg(code))).toMatchObject({ kind: "TRANSIENT", reason: "connection" });
    },
  );

  test.each(["23505", "23514", "23503", "23502", "23000", "22P02", "42P01", "42601"])(
    "SQLSTATE %s → PERMANENT",
    (code) => {
      expect(classifyError(pg(code))).toEqual({
        kind: "PERMANENT",
        reason: `sqlstate_${code}`,
        sqlState: code,
      });
    },
  );

  test("procura o código nas causas encadeadas (o ORM embrulha o erro do driver)", () => {
    const wrapped = new Error("wrapper", { cause: new Error("mid", { cause: pg("40P01") }) });
    expect(classifyError(wrapped)).toMatchObject({ kind: "TRANSIENT", sqlState: "40P01" });
  });

  test("não segue causas infinitas", () => {
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(classifyError(loop)).toEqual({ kind: "PERMANENT", reason: "unclassified" });
  });

  test("erro sem código reconhecível é PERMANENT/unclassified (falhar de forma auditável)", () => {
    const unknowns = [
      new Error("?"),
      "texto",
      null,
      undefined,
      42,
      { code: "naoeumsqlstate" },
      { code: 5 },
    ];
    for (const error of unknowns) {
      expect(classifyError(error)).toEqual({ kind: "PERMANENT", reason: "unclassified" });
    }
  });

  test("o resultado nunca vaza a mensagem original (pode conter dados do jogador)", () => {
    const secret = pg("23505", { message: "Key (player_id)=(abc-secret) already exists" });
    expect(JSON.stringify(classifyError(secret))).not.toContain("secret");
  });

  test("isTransient", () => {
    expect(isTransient(pg("40001"))).toBe(true);
    expect(isTransient(pg("23505"))).toBe(false);
    expect(isTransient(new InsufficientFundsError())).toBe(false);
  });
});
