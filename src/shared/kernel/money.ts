import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from "./errors";

/** Contrato de entrada/saída: string decimal com escala fixa de 2 + moeda ISO-4217. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Exatamente 2 casas, sem sinal, sem expoente, sem zeros à esquerda ("25", "25.5", "1e3" são inválidos). */
const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.(\d{2})$/;
/** Formato ISO-4217 (3 letras maiúsculas). Não valida contra a lista oficial de moedas. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_INPUT_LENGTH = 64;
const SCALE = 100n;
/** Limite de numeric(19,2): 9_999_999_999_999_999.99, em centavos. */
const MAX_MINOR = 10n ** 18n - 1n;

/**
 * Valor monetário imutável. Internamente guarda centavos em `bigint`: aritmética exata, sem
 * `number`/float em nenhum ponto (AR-01). Toda operação devolve uma nova instância.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Parse estrito de um contrato de entrada. Nunca arredonda: o que não cabe em 2 casas é rejeitado. */
  static from(props: MoneyProps): Money {
    if (typeof props !== "object" || props === null) {
      throw new InvalidMoneyError("money must be an object { amount, currency }");
    }
    const { amount, currency } = props;
    Money.assertCurrencyCode(currency);
    if (typeof amount !== "string") {
      throw new InvalidMoneyError("amount must be a decimal string");
    }
    if (amount.length > MAX_INPUT_LENGTH) {
      throw new InvalidMoneyError("amount is not a valid decimal with exactly 2 decimal places");
    }
    const match = AMOUNT_PATTERN.exec(amount);
    const whole = match?.[1];
    const fraction = match?.[2];
    if (whole === undefined || fraction === undefined) {
      throw new InvalidMoneyError("amount is not a valid decimal with exactly 2 decimal places");
    }
    return Money.ofMinor(BigInt(whole) * SCALE + BigInt(fraction), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrencyCode(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinor(this.minor + other.minor, this.currency);
  }

  /** Pode resultar em valor negativo (usado para diferenças); `Wallet` é quem proíbe saldo negativo. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinor(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return Money.ofMinor(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  /** Igualdade de valor: moedas diferentes nunca são iguais (não lança). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    const negative = this.minor < 0n;
    const absolute = negative ? -this.minor : this.minor;
    const whole = absolute / SCALE;
    const fraction = (absolute % SCALE).toString().padStart(2, "0");
    return `${negative ? "-" : ""}${whole}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrencyCode(currency: unknown): asserts currency is string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError("currency must be 3 uppercase letters (ISO-4217)");
    }
  }

  private static ofMinor(minor: bigint, currency: string): Money {
    if (minor > MAX_MINOR || minor < -MAX_MINOR) {
      throw new MoneyOverflowError("amount is outside the supported range");
    }
    return new Money(minor, currency);
  }
}
