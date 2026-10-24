import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  DomainError,
  InvalidMoneyError,
  Money,
  MoneyOverflowError,
  type MoneyProps,
} from "../../../../src/shared/kernel";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });
const MAX = "9999999999999999.99"; // limite de numeric(19,2)

describe("Money.from — entradas válidas (RF-MON-03)", () => {
  test.each([["0.00"], ["0.01"], ["0.10"], ["25.00"], ["1234567.89"], ["100.50"], [MAX]])(
    "aceita %s e serializa de volta idêntico",
    (amount) => {
      expect(brl(amount).toJSON()).toEqual({ amount, currency: "BRL" });
    },
  );

  test("toString usa a escala fixa de 2 casas e a moeda", () => {
    expect(brl("25.00").toString()).toBe("25.00 BRL");
    expect(brl("0.05").toString()).toBe("0.05 BRL");
  });

  test("JSON.stringify produz o contrato { amount, currency } com amount string", () => {
    expect(JSON.stringify(brl("25.00"))).toBe('{"amount":"25.00","currency":"BRL"}');
  });
});

describe("Money.from — entradas inválidas (RF-MON-05, AR-22)", () => {
  test.each([
    ["string vazia", ""],
    ["só espaços", "   "],
    ["sem casas decimais", "25"],
    ["1 casa decimal", "25.5"],
    ["3 casas decimais", "25.000"],
    ["mais de 2 casas (nunca arredonda)", "0.005"],
    ["mais de 2 casas, 999", "0.999"],
    ["negativo", "-1.00"],
    ["negativo zero", "-0.00"],
    ["sinal positivo", "+1.00"],
    ["notação científica", "1e3"],
    ["notação científica com casas", "1.00e2"],
    ["notação científica maiúscula", "1.00E2"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["-Infinity", "-Infinity"],
    ["sem parte inteira", ".50"],
    ["sem parte fracionária", "1."],
    ["zero à esquerda", "01.00"],
    ["vírgula decimal", "1,00"],
    ["separador de milhar", "1,000.00"],
    ["underscore", "1_000.00"],
    ["hexadecimal", "0x10"],
    ["espaço antes", " 1.00"],
    ["espaço depois", "1.00 "],
    ["quebra de linha", "1.00\n"],
    ["letras", "abc"],
    ["dígitos não ASCII", "٣.٠٠"],
    ["muito longo", `${"9".repeat(80)}.00`],
  ])("rejeita %s", (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test.each([
    ["number", 25],
    ["number com casas", 25.5],
    ["NaN numérico", Number.NaN],
    ["Infinity numérico", Number.POSITIVE_INFINITY],
    ["bigint", 2500n],
    ["null", null],
    ["undefined", undefined],
    ["boolean", true],
    ["objeto", {}],
    ["array", ["25.00"]],
  ])("rejeita amount do tipo %s (AR-01: dinheiro nunca é number)", (_label, amount) => {
    expect(() => Money.from({ amount, currency: "BRL" } as unknown as MoneyProps)).toThrow(
      InvalidMoneyError,
    );
  });

  test.each([
    ["minúscula", "brl"],
    ["2 letras", "BR"],
    ["4 letras", "BRLL"],
    ["vazia", ""],
    ["com dígito", "B1L"],
    ["com espaço", "BRL "],
    ["número", 986],
    ["null", null],
    ["undefined", undefined],
  ])("rejeita moeda inválida: %s", (_label, currency) => {
    expect(() => Money.from({ amount: "1.00", currency } as unknown as MoneyProps)).toThrow(
      InvalidMoneyError,
    );
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["string", "25.00 BRL"],
    ["number", 25],
  ])("rejeita o próprio argumento quando é %s", (_label, props) => {
    expect(() => Money.from(props as unknown as MoneyProps)).toThrow(InvalidMoneyError);
  });

  test("Money.zero também valida a moeda", () => {
    expect(() => Money.zero("brl")).toThrow(InvalidMoneyError);
  });

  test("a mensagem de erro não repete o valor recebido (AR-55)", () => {
    try {
      brl("123456.789");
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("123456");
    }
  });
});

describe("Money — limites (numeric(19,2))", () => {
  test("rejeita valor acima do máximo representável", () => {
    expect(() => brl("10000000000000000.00")).toThrow(MoneyOverflowError);
  });

  test("add que passa do máximo lança overflow", () => {
    expect(() => brl(MAX).add(brl("0.01"))).toThrow(MoneyOverflowError);
  });

  test("subtract abaixo do mínimo lança overflow", () => {
    expect(() => brl(MAX).negate().subtract(brl("0.01"))).toThrow(MoneyOverflowError);
  });

  test("o máximo exato é aceito e op que o atinge funciona", () => {
    expect(brl("9999999999999999.98").add(brl("0.01")).toJSON().amount).toBe(MAX);
  });
});

describe("Money — aritmética exata (RF-MON-02)", () => {
  test("zero", () => {
    const zero = Money.zero("BRL");
    expect(zero.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
    expect(zero.isZero()).toBe(true);
  });

  test("add e subtract", () => {
    expect(brl("10.50").add(brl("0.25")).toString()).toBe("10.75 BRL");
    expect(brl("10.50").subtract(brl("0.25")).toString()).toBe("10.25 BRL");
  });

  test("0.10 + 0.20 é exatamente 0.30 (o clássico erro de ponto flutuante)", () => {
    expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
  });

  test("somar 0.01 cem vezes dá exatamente 1.00", () => {
    let total = Money.zero("BRL");
    for (let i = 0; i < 100; i++) total = total.add(brl("0.01"));
    expect(total.toJSON().amount).toBe("1.00");
  });

  test("subtract pode produzir negativo; toString/toJSON refletem o sinal", () => {
    const result = brl("1.00").subtract(brl("3.50"));
    expect(result.isNegative()).toBe(true);
    expect(result.isPositive()).toBe(false);
    expect(result.toString()).toBe("-2.50 BRL");
    expect(result.toJSON().amount).toBe("-2.50");
  });

  test("subtract que cruza o zero mantém a escala (centavos < 10)", () => {
    expect(brl("0.10").subtract(brl("0.15")).toJSON().amount).toBe("-0.05");
  });

  test("negate", () => {
    expect(brl("25.00").negate().toJSON().amount).toBe("-25.00");
    expect(brl("25.00").negate().negate().equals(brl("25.00"))).toBe(true);
    expect(Money.zero("BRL").negate().isZero()).toBe(true);
  });

  test("a - a = 0 e (a + b) - b = a", () => {
    const a = brl("123.45");
    const b = brl("67.89");
    expect(a.subtract(a).isZero()).toBe(true);
    expect(a.add(b).subtract(b).equals(a)).toBe(true);
  });

  test("a adição é comutativa e associativa", () => {
    const a = brl("1.11");
    const b = brl("2.22");
    const c = brl("3.33");
    expect(a.add(b).equals(b.add(a))).toBe(true);
    expect(
      a
        .add(b)
        .add(c)
        .equals(a.add(b.add(c))),
    ).toBe(true);
  });
});

describe("Money — predicados e comparações", () => {
  test("isZero / isPositive / isNegative", () => {
    expect(brl("0.00").isZero()).toBe(true);
    expect(brl("0.00").isPositive()).toBe(false);
    expect(brl("0.00").isNegative()).toBe(false);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.01").isZero()).toBe(false);
  });

  test("isLessThan", () => {
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.01").isLessThan(brl("1.00"))).toBe(false);
    expect(brl("1.00").isLessThan(brl("1.00"))).toBe(false);
    expect(brl("1.00").negate().isLessThan(Money.zero("BRL"))).toBe(true);
  });

  test("equals compara valor e moeda", () => {
    expect(brl("25.00").equals(brl("25.00"))).toBe(true);
    expect(brl("25.00").equals(brl("25.01"))).toBe(false);
  });

  test("equals entre moedas diferentes é false (não lança)", () => {
    expect(brl("25.00").equals(usd("25.00"))).toBe(false);
  });
});

describe("Money — conflito de moeda (RF-MON-04, AR-14)", () => {
  test.each([
    ["add", (a: Money, b: Money) => a.add(b)],
    ["subtract", (a: Money, b: Money) => a.subtract(b)],
    ["isLessThan", (a: Money, b: Money) => a.isLessThan(b)],
  ])("%s entre BRL e USD lança CurrencyMismatchError", (_name, operation) => {
    expect(() => operation(brl("1.00"), usd("1.00"))).toThrow(CurrencyMismatchError);
  });

  test("o erro identifica as duas moedas e é um erro de domínio com code estável", () => {
    try {
      brl("1.00").add(usd("1.00"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const mismatch = error as CurrencyMismatchError;
      expect(mismatch.code).toBe("CURRENCY_MISMATCH");
      expect(mismatch.left).toBe("BRL");
      expect(mismatch.right).toBe("USD");
      expect(mismatch.name).toBe("CurrencyMismatchError");
    }
  });

  test("moedas diferentes funcionam isoladamente (modelo multi-moeda)", () => {
    expect(usd("10.00").add(usd("5.00")).toString()).toBe("15.00 USD");
  });
});

describe("Money — imutabilidade (RF-MON-01)", () => {
  test("as operações não alteram os operandos", () => {
    const a = brl("10.00");
    const b = brl("3.00");
    a.add(b);
    a.subtract(b);
    a.negate();
    expect(a.toJSON().amount).toBe("10.00");
    expect(b.toJSON().amount).toBe("3.00");
  });

  test("devolve novas instâncias", () => {
    const a = brl("10.00");
    expect(a.add(Money.zero("BRL"))).not.toBe(a);
  });

  test("a instância é congelada: não aceita atribuição", () => {
    const money = brl("10.00") as unknown as { currency: string; minor: bigint };
    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      money.currency = "USD";
    }).toThrow(TypeError);
    expect(() => {
      money.minor = 1n;
    }).toThrow(TypeError);
  });

  test("o objeto devolvido por toJSON é independente do estado interno", () => {
    const money = brl("10.00");
    const json = money.toJSON();
    json.amount = "999.00";
    expect(money.toJSON().amount).toBe("10.00");
  });
});

describe("Money — ida e volta (RF-MON-07)", () => {
  test("from(toJSON()) preserva o valor para uma varredura de valores", () => {
    const samples = [
      "0.00",
      "0.01",
      "0.09",
      "0.10",
      "0.99",
      "1.00",
      "9.99",
      "10.00",
      "99.99",
      "100.00",
      "1000000.00",
      "123456789.01",
      MAX,
    ];
    for (const amount of samples) {
      const original = brl(amount);
      expect(Money.from(original.toJSON()).equals(original)).toBe(true);
    }
  });

  test("valores de centavos de 0 a 999 passam pela ida e volta sem perda", () => {
    for (let cents = 0; cents < 1000; cents++) {
      const amount = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
      expect(brl(amount).toJSON().amount).toBe(amount);
    }
  });
});
