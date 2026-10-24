import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalize, hashCanonical, Money, sha256Hex } from "../../../../src/shared/kernel";

describe("canonicalize (RF-API-09)", () => {
  test("ordena as chaves em todos os níveis e remove espaços", () => {
    expect(canonicalize({ b: 1, a: { d: null, c: [3, 1] } })).toBe(
      '{"a":{"c":[3,1],"d":null},"b":1}',
    );
  });

  test("a ordem de inserção das chaves não altera o resultado", () => {
    const one = { providerId: "p", kind: "BET", money: { currency: "BRL", amount: "25.00" } };
    const two = { money: { amount: "25.00", currency: "BRL" }, kind: "BET", providerId: "p" };
    expect(canonicalize(one)).toBe(canonicalize(two));
  });

  test("arrays preservam a ordem", () => {
    expect(canonicalize([2, 1, 3])).not.toBe(canonicalize([1, 2, 3]));
    expect(canonicalize([2, 1, 3])).toBe("[2,1,3]");
  });

  test("strings são escapadas como no JSON padrão (aspas, barra, controle, unicode)", () => {
    expect(canonicalize({ k: 'a"b\\c\n\u0001é' })).toBe(JSON.stringify({ k: 'a"b\\c\n\u0001é' }));
  });

  test("chaves também são escapadas", () => {
    expect(canonicalize({ 'a"b': 1 })).toBe('{"a\\"b":1}');
  });

  test("escalares", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
    expect(canonicalize("x")).toBe('"x"');
    expect(canonicalize(0)).toBe("0");
    expect(canonicalize(-0)).toBe("0");
  });

  test("null e ausência produzem resultados diferentes (campo ausente deve ser null explícito)", () => {
    expect(canonicalize({ a: 1, ref: null })).not.toBe(canonicalize({ a: 1 }));
  });

  test("usa toJSON() quando existe (Money e Date)", () => {
    expect(canonicalize({ money: Money.from({ amount: "25.00", currency: "BRL" }) })).toBe(
      '{"money":{"amount":"25.00","currency":"BRL"}}',
    );
    expect(canonicalize(new Date("2026-01-01T00:00:00.000Z"))).toBe('"2026-01-01T00:00:00.000Z"');
  });

  test.each([
    ["undefined", undefined],
    ["undefined em propriedade", { a: undefined }],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["bigint", 1n],
    ["função", () => 1],
    ["símbolo", Symbol("x")],
    ["instância de classe sem toJSON", new (class Foo {})()],
    ["Map", new Map()],
  ])("rejeita %s", (_label, value) => {
    expect(() => canonicalize(value)).toThrow(TypeError);
  });

  test("a mensagem de erro aponta o caminho do valor inválido", () => {
    expect(() => canonicalize({ a: { b: [1, undefined] } })).toThrow("$.a.b[1]");
  });
});

describe("sha256Hex", () => {
  test("vetor de teste conhecido (abc)", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("string vazia", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("hexadecimal minúsculo de 64 caracteres", () => {
    expect(sha256Hex("qualquer coisa")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("codifica como UTF-8 (compara com o hash dos bytes c3 a9 calculado à parte)", () => {
    const expected = createHash("sha256")
      .update(Buffer.from([0xc3, 0xa9]))
      .digest("hex");
    expect(sha256Hex("é")).toBe(expected);
    expect(sha256Hex("é")).not.toBe(sha256Hex("e"));
  });
});

describe("hashCanonical", () => {
  const payload = {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    referenceExternalTransactionId: null,
    money: { amount: "25.00", currency: "BRL" },
  };

  test("é estável: o mesmo conteúdo sempre dá o mesmo hash", () => {
    expect(hashCanonical(payload)).toBe(hashCanonical({ ...payload }));
  });

  test("não depende da ordem das chaves", () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    expect(hashCanonical(reordered)).toBe(hashCanonical(payload));
  });

  test("muda quando qualquer campo de negócio muda", () => {
    const base = hashCanonical(payload);
    expect(hashCanonical({ ...payload, kind: "WIN" })).not.toBe(base);
    expect(hashCanonical({ ...payload, roundId: "round-988" })).not.toBe(base);
    expect(hashCanonical({ ...payload, money: { amount: "25.01", currency: "BRL" } })).not.toBe(
      base,
    );
    expect(hashCanonical({ ...payload, money: { amount: "25.00", currency: "USD" } })).not.toBe(
      base,
    );
    expect(hashCanonical({ ...payload, referenceExternalTransactionId: "tx-1" })).not.toBe(base);
  });

  test("aceita Money diretamente no payload", () => {
    const withMoney = { ...payload, money: Money.from({ amount: "25.00", currency: "BRL" }) };
    expect(hashCanonical(withMoney)).toBe(hashCanonical(payload));
  });
});
