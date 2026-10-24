import { describe, expect, test } from "bun:test";
import {
  assertPlainJson,
  backoffDelayMs,
  deepFreeze,
  InvalidArgumentError,
  Money,
} from "../../../../src/shared/kernel";

const CFG = { baseMs: 2_000, capMs: 300_000 };

describe("backoffDelayMs", () => {
  test("dobra a cada tentativa a partir da base", () => {
    expect([1, 2, 3, 4].map((n) => backoffDelayMs(n, CFG))).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  test("respeita o teto, inclusive com tentativas enormes", () => {
    expect(backoffDelayMs(9, CFG)).toBe(300_000);
    expect(backoffDelayMs(10_000, CFG)).toBe(300_000);
  });

  test("o teto exato é alcançado sem ultrapassar", () => {
    expect(backoffDelayMs(8, CFG)).toBe(256_000);
    expect(backoffDelayMs(8, { baseMs: 2_000, capMs: 256_000 })).toBe(256_000);
  });

  test("o jitter multiplica DEPOIS do teto e arredonda", () => {
    expect(backoffDelayMs(1, CFG, 1.25)).toBe(2_500);
    expect(backoffDelayMs(20, CFG, 0.8)).toBe(240_000);
    expect(backoffDelayMs(1, { baseMs: 3, capMs: 10 }, 1.5)).toBe(5); // 4.5 → 5
  });

  test("é determinístico", () => {
    expect(backoffDelayMs(5, CFG, 1.1)).toBe(backoffDelayMs(5, CFG, 1.1));
  });

  test.each([0, -1, 1.5, Number.NaN])("rejeita attempt %p", (attempt) => {
    expect(() => backoffDelayMs(attempt, CFG)).toThrow("attempt");
  });

  test("rejeita configuração inválida", () => {
    expect(() => backoffDelayMs(1, { baseMs: 0, capMs: 10 })).toThrow("backoff config");
    expect(() => backoffDelayMs(1, { baseMs: 10, capMs: 5 })).toThrow("backoff config");
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejeita jitter %p", (jitter) => {
    expect(() => backoffDelayMs(1, CFG, jitter)).toThrow("jitter");
  });
});

describe("assertPlainJson", () => {
  test("aceita JSON puro aninhado", () => {
    expect(() =>
      assertPlainJson({ a: [1, "x", null, true, { b: 2.5 }], c: Object.create(null) }, "f"),
    ).not.toThrow();
  });

  test("rejeita instâncias (Money, Date), com o caminho do problema", () => {
    expect(() =>
      assertPlainJson({ money: Money.from({ amount: "1.00", currency: "BRL" }) }, "f"),
    ).toThrow("non-plain object at $.money");
    expect(() => assertPlainJson({ list: [new Date()] }, "f")).toThrow("$.list[0]");
  });

  test.each([
    ["undefined", undefined],
    ["bigint", 1n],
    ["função", () => 1],
    ["símbolo", Symbol("x")],
  ])("rejeita %s", (_n, value) => {
    expect(() => assertPlainJson({ v: value }, "f")).toThrow(InvalidArgumentError);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY])("rejeita número não finito %p", (n) => {
    expect(() => assertPlainJson([n], "f")).toThrow("non-finite");
  });
});

describe("deepFreeze", () => {
  test("congela objetos e arrays aninhados", () => {
    const value = deepFreeze({ a: { b: [1, { c: 2 }] } });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
    expect(Object.isFrozen(value.a.b)).toBe(true);
    expect(Object.isFrozen(value.a.b[1])).toBe(true);
  });

  test("tolera primitivos e null", () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(3)).toBe(3);
  });
});
