import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  DomainError,
  InvalidArgumentError,
} from "../../../../src/shared/kernel";
import {
  type CreateLedgerEntryProps,
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
} from "../../../../src/wallet/domain";
import { brl, usd } from "../../../support/money";

const base = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: "entry-1",
  walletId: "wallet-1",
  transactionId: "tx-1",
  direction: LedgerDirection.Credit,
  money: brl("25.00"),
  balanceBefore: brl("100.00"),
  balanceAfter: brl("125.00"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

describe("WalletLedgerEntry.create — aritmética (RF-LED-02)", () => {
  test("CREDIT: before + money = after", () => {
    const entry = WalletLedgerEntry.create(base());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.toString()).toBe("125.00 BRL");
  });

  test("DEBIT: before - money = after", () => {
    const entry = WalletLedgerEntry.create(
      base({ direction: LedgerDirection.Debit, balanceAfter: brl("75.00") }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  test("DEBIT que zera o saldo é válido", () => {
    const entry = WalletLedgerEntry.create(
      base({
        direction: LedgerDirection.Debit,
        balanceBefore: brl("25.00"),
        balanceAfter: brl("0.00"),
      }),
    );
    expect(entry.balanceAfter.isZero()).toBe(true);
  });

  test("CREDIT a partir de saldo zero (lançamento de abertura)", () => {
    const entry = WalletLedgerEntry.create(
      base({ balanceBefore: brl("0.00"), balanceAfter: brl("25.00") }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  test.each([
    ["CREDIT com after errado", { balanceAfter: brl("124.99") }],
    ["CREDIT que na verdade subtraiu", { balanceAfter: brl("75.00") }],
    [
      "DEBIT que na verdade somou",
      { direction: LedgerDirection.Debit, balanceAfter: brl("125.00") },
    ],
    ["DEBIT com after errado", { direction: LedgerDirection.Debit, balanceAfter: brl("74.99") }],
    ["after igual ao before", { balanceAfter: brl("100.00") }],
  ] as const)("rejeita lançamento desbalanceado: %s", (_label, overrides) => {
    expect(() => WalletLedgerEntry.create(base(overrides))).toThrow(InvalidLedgerEntryError);
  });
});

describe("WalletLedgerEntry.create — validações de campo", () => {
  // Os casos abaixo são aritmeticamente CONSISTENTES de propósito: o que os reprova é a regra de
  // "valor positivo", não a conta que não fecha.
  test.each([
    [
      "valor zero (CREDIT, before = after)",
      { money: brl("0.00"), balanceBefore: brl("100.00"), balanceAfter: brl("100.00") },
    ],
    [
      "valor zero (DEBIT, before = after)",
      {
        direction: LedgerDirection.Debit,
        money: brl("0.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("100.00"),
      },
    ],
    [
      "valor negativo (CREDIT que fecha a conta: 100 + (-25) = 75)",
      { money: brl("25.00").negate(), balanceBefore: brl("100.00"), balanceAfter: brl("75.00") },
    ],
  ])("rejeita %s", (_label, overrides) => {
    expect(() => WalletLedgerEntry.create(base(overrides))).toThrow(
      "ledger entry amount must be positive",
    );
  });

  test("rejeita saldo anterior ou posterior negativo", () => {
    expect(() =>
      WalletLedgerEntry.create(
        base({ balanceBefore: brl("10.00").negate(), balanceAfter: brl("15.00") }),
      ),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create(
        base({
          direction: LedgerDirection.Debit,
          balanceBefore: brl("10.00"),
          balanceAfter: brl("15.00").negate(),
        }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejeita moedas divergentes entre valor e saldos (RF-WAL-05)", () => {
    expect(() => WalletLedgerEntry.create(base({ balanceBefore: usd("100.00") }))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => WalletLedgerEntry.create(base({ balanceAfter: usd("125.00") }))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => WalletLedgerEntry.create(base({ money: usd("25.00") }))).toThrow(
      CurrencyMismatchError,
    );
  });

  test("rejeita direção desconhecida", () => {
    expect(() =>
      WalletLedgerEntry.create(base({ direction: "SIDEWAYS" as unknown as LedgerDirection })),
    ).toThrow(InvalidLedgerEntryError);
  });

  test.each([
    ["id", { id: "" }],
    ["walletId", { walletId: "  " }],
    ["transactionId", { transactionId: "" }],
  ])("rejeita %s vazio", (_field, overrides) => {
    expect(() => WalletLedgerEntry.create(base(overrides))).toThrow(InvalidArgumentError);
  });

  test("rejeita data inválida", () => {
    expect(() => WalletLedgerEntry.create(base({ createdAt: new Date("nope") }))).toThrow(
      InvalidArgumentError,
    );
  });

  test("os erros são erros de domínio com code estável", () => {
    try {
      WalletLedgerEntry.create(base({ balanceAfter: brl("1.00") }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as InvalidLedgerEntryError).code).toBe("INVALID_LEDGER_ENTRY");
    }
  });
});

describe("WalletLedgerEntry — imutabilidade estrutural (RF-LED-01, AR-21)", () => {
  test("a instância é congelada: nenhum campo aceita atribuição", () => {
    const entry = WalletLedgerEntry.create(base()) as unknown as Record<string, unknown>;
    expect(Object.isFrozen(entry)).toBe(true);
    for (const field of [
      "id",
      "walletId",
      "transactionId",
      "direction",
      "money",
      "balanceBefore",
      "balanceAfter",
    ]) {
      expect(() => {
        entry[field] = "changed";
      }).toThrow(TypeError);
    }
  });

  test("não existe método de transição nem setter", () => {
    const names = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter(
      (n) => n !== "constructor",
    );
    expect(names.sort()).toEqual(["createdAt", "isBalanced"]);
    const descriptor = Object.getOwnPropertyDescriptor(WalletLedgerEntry.prototype, "createdAt");
    expect(descriptor?.set).toBeUndefined();
  });

  test("createdAt devolve uma cópia: mutar a data devolvida não altera o lançamento", () => {
    const entry = WalletLedgerEntry.create(base());
    entry.createdAt.setFullYear(1999);
    expect(entry.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  test("a data passada na criação também é copiada", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const entry = WalletLedgerEntry.create(base({ createdAt }));
    createdAt.setFullYear(1999);
    expect(entry.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  test("os valores monetários são imutáveis por construção", () => {
    const entry = WalletLedgerEntry.create(base());
    expect(Object.isFrozen(entry.money)).toBe(true);
    expect(Object.isFrozen(entry.balanceBefore)).toBe(true);
  });
});

describe("WalletLedgerEntry.rehydrate (RNF-MOD-02)", () => {
  test("reconstrói o estado persistido e preserva todos os campos", () => {
    const state = base();
    const entry = WalletLedgerEntry.rehydrate(state);
    expect(entry.id).toBe("entry-1");
    expect(entry.walletId).toBe("wallet-1");
    expect(entry.transactionId).toBe("tx-1");
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.money.equals(brl("25.00"))).toBe(true);
    expect(entry.balanceBefore.equals(brl("100.00"))).toBe(true);
    expect(entry.balanceAfter.equals(brl("125.00"))).toBe(true);
    expect(entry.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(entry.isBalanced()).toBe(true);
  });

  test("NÃO revalida: estado corrompido é reconstruído e isBalanced() acusa o problema", () => {
    const corrupted = WalletLedgerEntry.rehydrate(base({ balanceAfter: brl("999.00") }));
    expect(corrupted.isBalanced()).toBe(false);
  });

  test("moedas incoerentes em estado reidratado contam como não balanceado (sem lançar)", () => {
    const corrupted = WalletLedgerEntry.rehydrate(base({ balanceBefore: usd("100.00") }));
    expect(corrupted.isBalanced()).toBe(false);
  });

  test("create e rehydrate do mesmo estado válido são equivalentes", () => {
    const created = WalletLedgerEntry.create(base());
    const rehydrated = WalletLedgerEntry.rehydrate(base());
    expect(JSON.stringify(rehydrated)).toBe(JSON.stringify(created));
  });
});
