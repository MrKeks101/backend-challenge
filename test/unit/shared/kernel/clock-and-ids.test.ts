import { describe, expect, test } from "bun:test";
import {
  DomainError,
  InvalidTransactionStateError,
  isUuid,
  SystemClock,
  Uuid7Generator,
} from "../../../../src/shared/kernel";

describe("SystemClock", () => {
  test("now() devolve a hora atual", () => {
    const before = Date.now();
    const value = new SystemClock().now().getTime();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  test("devolve uma nova instância de Date a cada chamada", () => {
    const clock = new SystemClock();
    expect(clock.now()).not.toBe(clock.now());
  });
});

describe("Uuid7Generator", () => {
  const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  test("gera UUIDv7 válidos", () => {
    const generator = new Uuid7Generator();
    for (let i = 0; i < 50; i++) expect(generator.next()).toMatch(UUID_V7);
  });

  test("não repete e mantém ordem crescente (bom para índices)", () => {
    const generator = new Uuid7Generator();
    const ids = Array.from({ length: 2000 }, () => generator.next());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
  });

  test("isUuid aceita UUIDs e rejeita o resto", () => {
    expect(isUuid(new Uuid7Generator().next())).toBe(true);
    expect(isUuid("0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

describe("InvalidTransactionStateError", () => {
  test("é um erro de domínio com code estável e identifica a transição", () => {
    const error = new InvalidTransactionStateError("PROCESSED", "REJECTED");
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("INVALID_TRANSACTION_STATE");
    expect(error.from).toBe("PROCESSED");
    expect(error.to).toBe("REJECTED");
    expect(error.name).toBe("InvalidTransactionStateError");
  });
});
