import { describe, expect, test } from "bun:test";
import { HttpException, NotFoundException } from "@nestjs/common";
import { OptimisticLockError } from "../../../../src/shared/infrastructure/persistence/errors";
import { ApiProblem } from "../../../../src/shared/interfaces/http/problem";
import { toProblem } from "../../../../src/shared/interfaces/http/problem-mapper";
import {
  CurrencyMismatchError,
  InvalidArgumentError,
  InvalidMoneyError,
  MoneyOverflowError,
} from "../../../../src/shared/kernel";
import {
  InvalidCursorError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../../../src/wallet/application/errors";
import { InsufficientFundsError, InvalidWalletError } from "../../../../src/wallet/domain";

const sqlError = (code: string) => Object.assign(new Error("boom with balance 123.45"), { code });

describe("toProblem: erros de domínio e da borda", () => {
  const cases: [string, unknown, number, string][] = [
    ["wallet inexistente", new WalletNotFoundError(), 404, "WALLET_NOT_FOUND"],
    ["wallet duplicada", new WalletAlreadyExistsError(), 409, "WALLET_ALREADY_EXISTS"],
    ["cursor inválido", new InvalidCursorError(), 400, "INVALID_CURSOR"],
    ["dinheiro malformado", new InvalidMoneyError("x"), 400, "INVALID_PAYLOAD"],
    ["overflow de dinheiro", new MoneyOverflowError("x"), 400, "INVALID_PAYLOAD"],
    ["argumento inválido", new InvalidArgumentError("x"), 400, "INVALID_PAYLOAD"],
    ["wallet inválida", new InvalidWalletError("x"), 400, "INVALID_PAYLOAD"],
    [
      "outro erro de domínio é 422 com o próprio code",
      new InsufficientFundsError(),
      422,
      "INSUFFICIENT_FUNDS",
    ],
    ["moeda diferente é 422", new CurrencyMismatchError("BRL", "USD"), 422, "CURRENCY_MISMATCH"],
  ];
  for (const [label, error, status, code] of cases) {
    test(label, () => {
      const problem = toProblem(error);
      expect(problem.status).toBe(status);
      expect(problem.code).toBe(code);
      expect(problem.loggable).toBeUndefined();
    });
  }

  test("ApiProblem mantém status, code, errors[] e headers", () => {
    const problem = toProblem(
      new ApiProblem(409, "X", "detalhe", [{ path: "a", message: "b" }], { "X-Y": "1" }),
    );
    expect(problem).toMatchObject({
      status: 409,
      code: "X",
      detail: "detalhe",
      errors: [{ path: "a", message: "b" }],
      headers: { "X-Y": "1" },
    });
  });

  test("HttpException do Nest: 404 vira NOT_FOUND, 400 vira INVALID_PAYLOAD", () => {
    expect(toProblem(new NotFoundException())).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(toProblem(new HttpException("x", 400))).toMatchObject({
      status: 400,
      code: "INVALID_PAYLOAD",
    });
    expect(toProblem(new HttpException("x", 418))).toMatchObject({
      status: 418,
      code: "HTTP_ERROR",
    });
  });

  test("erros do body-parser: JSON inválido, corpo grande e charset", () => {
    expect(toProblem({ type: "entity.parse.failed", status: 400 })).toMatchObject({
      status: 400,
      code: "INVALID_PAYLOAD",
    });
    expect(toProblem({ type: "entity.too.large", status: 413 })).toMatchObject({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(toProblem({ type: "charset.unsupported", status: 415 })).toMatchObject({
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
    });
  });
});

describe("toProblem: falhas de infraestrutura", () => {
  test("transitórias viram 503 com Retry-After (seguro reenviar)", () => {
    for (const error of [
      sqlError("40001"),
      sqlError("40P01"),
      sqlError("55P03"),
      sqlError("57014"),
      sqlError("ECONNRESET"),
      new OptimisticLockError("x"),
    ]) {
      const problem = toProblem(error);
      expect(problem.status).toBe(503);
      expect(problem.code).toBe("SERVICE_UNAVAILABLE");
      expect(problem.headers["Retry-After"]).toBe("1");
      expect(problem.loggable?.kind).toBe("TRANSIENT");
    }
  });

  test("permanentes e desconhecidas viram 500 sem Retry-After", () => {
    for (const error of [sqlError("23514"), new TypeError("x"), "string solta", null]) {
      const problem = toProblem(error);
      expect(problem.status).toBe(500);
      expect(problem.code).toBe("INTERNAL_ERROR");
      expect(problem.headers["Retry-After"]).toBeUndefined();
    }
  });

  test("nunca vaza a mensagem original (pode conter saldo) nem para o cliente nem para o log", () => {
    for (const error of [sqlError("40001"), sqlError("23514")]) {
      const problem = toProblem(error);
      expect(JSON.stringify(problem)).not.toContain("123.45");
      expect(JSON.stringify(problem)).not.toContain("boom");
    }
  });
});
