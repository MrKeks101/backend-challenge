import { describe, expect, test } from "bun:test";
import { InvalidArgumentError, requireDate, requireText } from "../../../../src/shared/kernel";

describe("requireText", () => {
  test("devolve o texto quando válido", () => {
    expect(requireText("abc", "campo")).toBe("abc");
  });

  test.each([[""], ["   "], ["\n\t"], [null], [undefined], [42], [{}], [[]]])(
    "rejeita %p",
    (value) => {
      expect(() => requireText(value, "campo")).toThrow(InvalidArgumentError);
    },
  );

  test("a mensagem cita o campo e nunca o valor", () => {
    try {
      requireText("", "walletId");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("walletId");
      expect((error as InvalidArgumentError).code).toBe("INVALID_ARGUMENT");
    }
  });
});

describe("requireDate", () => {
  test("devolve uma cópia da data", () => {
    const original = new Date("2026-01-01T00:00:00.000Z");
    const copy = requireDate(original, "at");
    expect(copy).not.toBe(original);
    expect(copy.getTime()).toBe(original.getTime());
    copy.setFullYear(1999);
    expect(original.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  test.each([[new Date("invalid")], ["2026-01-01"], [1767225600000], [null], [undefined]])(
    "rejeita %p",
    (value) => {
      expect(() => requireDate(value, "at")).toThrow(InvalidArgumentError);
    },
  );
});
