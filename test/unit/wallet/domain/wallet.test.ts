import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  DomainError,
  InvalidArgumentError,
  type Money,
} from "../../../../src/shared/kernel";
import {
  InsufficientFundsError,
  InvalidWalletError,
  LedgerDirection,
  Wallet,
  type WalletLedgerEntry,
} from "../../../../src/wallet/domain";
import { brl, seededRandom, usd } from "../../../support/money";

const T0 = new Date("2026-01-01T00:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function openWallet(initial = "100.00", currency: "BRL" | "USD" = "BRL"): Wallet {
  const initialBalance = currency === "BRL" ? brl(initial) : usd(initial);
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance,
    createdAt: T0,
    opening: { entryId: "entry-open", transactionId: "tx-open" },
  }).wallet;
}

let counter = 0;
const movement = (money: Money, seconds = 1) => ({
  entryId: `entry-${++counter}`,
  transactionId: `tx-${counter}`,
  money,
  at: at(seconds),
});

describe("Wallet.open (RF-WAL-01, RF-WAL-06)", () => {
  test("abre com saldo inicial, version 1 e moeda do saldo", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "w",
      playerId: "p",
      initialBalance: brl("1000.00"),
      createdAt: T0,
      opening: { entryId: "e", transactionId: "t" },
    });
    expect(wallet.id).toBe("w");
    expect(wallet.playerId).toBe("p");
    expect(wallet.currency).toBe("BRL");
    expect(wallet.balance.toString()).toBe("1000.00 BRL");
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt.toISOString()).toBe(T0.toISOString());
    expect(wallet.updatedAt.toISOString()).toBe(T0.toISOString());
    expect(openingEntry).not.toBeNull();
  });

  test("saldo inicial positivo gera o lançamento CREDIT de abertura, balanceado a partir de zero", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "w",
      playerId: "p",
      initialBalance: brl("1000.00"),
      createdAt: T0,
      opening: { entryId: "entry-open", transactionId: "tx-open" },
    });
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.walletId).toBe(wallet.id);
    expect(openingEntry?.transactionId).toBe("tx-open");
    expect(openingEntry?.balanceBefore.isZero()).toBe(true);
    expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(openingEntry?.isBalanced()).toBe(true);
  });

  test("saldo inicial zero não gera lançamento e mantém version 1", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "w",
      playerId: "p",
      initialBalance: brl("0.00"),
      createdAt: T0,
    });
    expect(openingEntry).toBeNull();
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test("a wallet herda a moeda do saldo inicial (modelo multi-moeda)", () => {
    expect(openWallet("10.00", "USD").currency).toBe("USD");
  });

  test("rejeita saldo inicial negativo (com os ids de abertura presentes, para isolar a regra)", () => {
    expect(() =>
      Wallet.open({
        id: "w",
        playerId: "p",
        initialBalance: brl("1.00").negate(),
        createdAt: T0,
        opening: { entryId: "e", transactionId: "t" },
      }),
    ).toThrow("initial balance must not be negative");
  });

  test("saldo inicial positivo exige os ids da abertura", () => {
    expect(() =>
      Wallet.open({ id: "w", playerId: "p", initialBalance: brl("1.00"), createdAt: T0 }),
    ).toThrow(InvalidWalletError);
  });

  test.each([
    ["id vazio", { id: "" }],
    ["playerId vazio", { playerId: " " }],
  ])("rejeita %s", (_label, overrides) => {
    expect(() =>
      Wallet.open({
        id: "w",
        playerId: "p",
        initialBalance: brl("0.00"),
        createdAt: T0,
        ...overrides,
      }),
    ).toThrow(InvalidArgumentError);
  });

  test("rejeita data de criação inválida", () => {
    expect(() =>
      Wallet.open({
        id: "w",
        playerId: "p",
        initialBalance: brl("0.00"),
        createdAt: new Date("x"),
      }),
    ).toThrow(InvalidArgumentError);
  });
});

describe("Wallet.debit (RF-WAL-03, RF-WAL-04)", () => {
  test("reduz o saldo, sobe a version e devolve o lançamento DEBIT correspondente", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.debit(movement(brl("30.00"), 5));

    expect(wallet.balance.toString()).toBe("70.00 BRL");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.toISOString()).toBe(at(5).toISOString());

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletId).toBe("wallet-1");
    expect(entry.money.toString()).toBe("30.00 BRL");
    expect(entry.balanceBefore.toString()).toBe("100.00 BRL");
    expect(entry.balanceAfter.toString()).toBe("70.00 BRL");
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(entry.isBalanced()).toBe(true);
    expect(entry.createdAt.toISOString()).toBe(at(5).toISOString());
  });

  test("usa os ids informados no movimento", () => {
    const wallet = openWallet();
    const entry = wallet.debit({
      entryId: "E-9",
      transactionId: "T-9",
      money: brl("1.00"),
      at: at(1),
    });
    expect(entry.id).toBe("E-9");
    expect(entry.transactionId).toBe("T-9");
  });

  test("débito do saldo exato zera a wallet (permitido)", () => {
    const wallet = openWallet("80.00");
    wallet.debit(movement(brl("80.00")));
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  test("saldo insuficiente lança InsufficientFundsError e NÃO altera nada", () => {
    const wallet = openWallet("100.00");
    expect(() => wallet.debit(movement(brl("100.01"), 9))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe("100.00 BRL");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt.toISOString()).toBe(T0.toISOString());
  });

  test("cenário do desafio: 100,00 e duas apostas de 80,00 em sequência → só a primeira passa, saldo 20,00", () => {
    const wallet = openWallet("100.00");
    const first = wallet.debit(movement(brl("80.00")));
    expect(() => wallet.debit(movement(brl("80.00")))).toThrow(InsufficientFundsError);
    expect(first.balanceAfter.toString()).toBe("20.00 BRL");
    expect(wallet.balance.toString()).toBe("20.00 BRL");
    expect(wallet.version).toBe(2);
  });

  test("o erro é de domínio, com code estável e sem repetir valores", () => {
    const wallet = openWallet("1.00");
    try {
      wallet.debit(movement(brl("123.00")));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as InsufficientFundsError).code).toBe("INSUFFICIENT_FUNDS");
      expect((error as Error).message).not.toContain("123");
    }
  });
});

describe("Wallet.credit", () => {
  test("aumenta o saldo, sobe a version e devolve o lançamento CREDIT", () => {
    const wallet = openWallet("100.00");
    const entry = wallet.credit(movement(brl("25.50"), 3));
    expect(wallet.balance.toString()).toBe("125.50 BRL");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe("100.00 BRL");
    expect(entry.balanceAfter.toString()).toBe("125.50 BRL");
    expect(entry.isBalanced()).toBe(true);
  });

  test("crédito em wallet com saldo zero", () => {
    const wallet = openWallet("0.00");
    wallet.credit(movement(brl("10.00")));
    expect(wallet.balance.toString()).toBe("10.00 BRL");
    expect(wallet.version).toBe(2);
  });

  test("estouro do limite numérico falha sem alterar a wallet", () => {
    const wallet = openWallet("9999999999999999.99");
    expect(() => wallet.credit(movement(brl("0.01")))).toThrow(DomainError);
    expect(wallet.balance.toString()).toBe("9999999999999999.99 BRL");
    expect(wallet.version).toBe(1);
  });
});

describe("Wallet — movimentos inválidos (todos atômicos: a wallet fica intocada)", () => {
  test.each([
    ["debit", (w: Wallet, m: ReturnType<typeof movement>) => w.debit(m)],
    ["credit", (w: Wallet, m: ReturnType<typeof movement>) => w.credit(m)],
  ])("%s com valor zero é rejeitado", (_op, apply) => {
    const wallet = openWallet();
    expect(() => apply(wallet, movement(brl("0.00")))).toThrow(InvalidWalletError);
    expect(wallet.version).toBe(1);
  });

  test.each([
    ["debit", (w: Wallet, m: ReturnType<typeof movement>) => w.debit(m)],
    ["credit", (w: Wallet, m: ReturnType<typeof movement>) => w.credit(m)],
  ])("%s com valor negativo é rejeitado", (_op, apply) => {
    const wallet = openWallet();
    expect(() => apply(wallet, movement(brl("5.00").negate()))).toThrow(InvalidWalletError);
    expect(wallet.balance.toString()).toBe("100.00 BRL");
    expect(wallet.version).toBe(1);
  });

  test.each([
    ["debit", (w: Wallet, m: ReturnType<typeof movement>) => w.debit(m)],
    ["credit", (w: Wallet, m: ReturnType<typeof movement>) => w.credit(m)],
  ])("%s em moeda diferente da wallet lança CurrencyMismatchError (RF-WAL-05)", (_op, apply) => {
    const wallet = openWallet("100.00", "BRL");
    expect(() => apply(wallet, movement(usd("10.00")))).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toString()).toBe("100.00 BRL");
    expect(wallet.version).toBe(1);
  });

  test("movimento com ids vazios ou data inválida é rejeitado sem alterar a wallet", () => {
    const wallet = openWallet();
    expect(() => wallet.debit({ ...movement(brl("1.00")), entryId: "" })).toThrow(
      InvalidArgumentError,
    );
    expect(() => wallet.debit({ ...movement(brl("1.00")), transactionId: " " })).toThrow(
      InvalidArgumentError,
    );
    expect(() => wallet.debit({ ...movement(brl("1.00")), at: new Date("x") })).toThrow(
      InvalidArgumentError,
    );
    expect(wallet.balance.toString()).toBe("100.00 BRL");
    expect(wallet.version).toBe(1);
  });
});

describe("Wallet — version (RF-WAL-06)", () => {
  test("sobe exatamente 1 por mudança de saldo e não sobe em falhas", () => {
    const wallet = openWallet("100.00");
    expect(wallet.version).toBe(1);
    wallet.debit(movement(brl("10.00")));
    expect(wallet.version).toBe(2);
    wallet.credit(movement(brl("5.00")));
    expect(wallet.version).toBe(3);
    expect(() => wallet.debit(movement(brl("1000.00")))).toThrow();
    expect(wallet.version).toBe(3);
    expect(() => wallet.credit(movement(brl("0.00")))).toThrow();
    expect(wallet.version).toBe(3);
  });

  test("ler propriedades não muda a version", () => {
    const wallet = openWallet();
    void wallet.balance;
    void wallet.updatedAt;
    expect(wallet.version).toBe(1);
  });
});

describe("Wallet — invariante saldo == ledger (propriedade, 500 operações pseudoaleatórias)", () => {
  test("o saldo sempre é igual ao reconstruído pelos lançamentos, nunca fica negativo e o ledger encadeia", () => {
    const random = seededRandom(20260101);
    const { wallet, openingEntry } = Wallet.open({
      id: "wallet-prop",
      playerId: "player",
      initialBalance: brl("500.00"),
      createdAt: T0,
      opening: { entryId: "entry-open", transactionId: "tx-open" },
    });
    const ledger: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];
    let applied = 0;
    let rejected = 0;

    for (let i = 0; i < 500; i++) {
      const cents = 1 + Math.floor(random() * 30000);
      const money = brl(`${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`);
      const isDebit = random() < 0.55;
      try {
        ledger.push(isDebit ? wallet.debit(movement(money, i)) : wallet.credit(movement(money, i)));
        applied++;
      } catch (error) {
        expect(error).toBeInstanceOf(InsufficientFundsError);
        rejected++;
      }
      expect(wallet.balance.isNegative()).toBe(false);
    }

    expect(applied).toBeGreaterThan(50);
    expect(rejected).toBeGreaterThan(0); // o caminho de rejeição também foi exercitado

    // saldo reconstruído pelo ledger == saldo materializado
    const rebuilt = ledger.reduce(
      (total, e) =>
        e.direction === LedgerDirection.Credit ? total.add(e.money) : total.subtract(e.money),
      brl("0.00"),
    );
    expect(rebuilt.equals(wallet.balance)).toBe(true);

    // todo lançamento fecha e encadeia com o anterior
    ledger.forEach((entry, index) => {
      expect(entry.isBalanced()).toBe(true);
      if (index > 0)
        expect(entry.balanceBefore.equals(ledger[index - 1]?.balanceAfter as Money)).toBe(true);
    });

    // uma mudança de saldo ⇔ um lançamento ⇔ uma unidade de version
    expect(wallet.version).toBe(1 + applied);
    expect(ledger.length).toBe(1 + applied);
  });
});

describe("Wallet.rehydrate (RNF-MOD-02)", () => {
  const state = {
    id: "wallet-1",
    playerId: "player-1",
    currency: "BRL",
    balance: brl("70.00"),
    version: 4,
    createdAt: T0,
    updatedAt: at(60),
  };

  test("reconstrói o estado persistido sem alterá-lo", () => {
    const wallet = Wallet.rehydrate(state);
    expect(wallet.id).toBe("wallet-1");
    expect(wallet.playerId).toBe("player-1");
    expect(wallet.currency).toBe("BRL");
    expect(wallet.balance.toString()).toBe("70.00 BRL");
    expect(wallet.version).toBe(4);
    expect(wallet.createdAt.toISOString()).toBe(T0.toISOString());
    expect(wallet.updatedAt.toISOString()).toBe(at(60).toISOString());
  });

  test("não revalida: aceita o que o banco entregou, sem checar regras de abertura", () => {
    expect(() =>
      Wallet.rehydrate({ ...state, balance: brl("1.00").negate(), version: 0 }),
    ).not.toThrow();
  });

  test("a wallet reidratada continua a sequência de versions e ledger", () => {
    const wallet = Wallet.rehydrate(state);
    const entry = wallet.debit(movement(brl("20.00"), 120));
    expect(wallet.version).toBe(5);
    expect(entry.balanceBefore.toString()).toBe("70.00 BRL");
    expect(entry.balanceAfter.toString()).toBe("50.00 BRL");
  });

  test("insuficiência de saldo continua valendo após reidratar", () => {
    expect(() => Wallet.rehydrate(state).debit(movement(brl("70.01")))).toThrow(
      InsufficientFundsError,
    );
  });
});

describe("Wallet — encapsulamento", () => {
  test("createdAt e updatedAt devolvem cópias: mutá-las não altera a wallet", () => {
    const wallet = openWallet();
    wallet.createdAt.setFullYear(1999);
    wallet.updatedAt.setFullYear(1999);
    expect(wallet.createdAt.toISOString()).toBe(T0.toISOString());
    expect(wallet.updatedAt.toISOString()).toBe(T0.toISOString());
  });

  test("a data do movimento é copiada: mutá-la depois não altera updatedAt", () => {
    const wallet = openWallet();
    const when = at(10);
    wallet.credit({ entryId: "e", transactionId: "t", money: brl("1.00"), at: when });
    when.setFullYear(1999);
    expect(wallet.updatedAt.toISOString()).toBe(at(10).toISOString());
  });

  test("não há setters públicos para saldo nem version", () => {
    for (const property of ["balance", "version", "updatedAt", "createdAt"]) {
      const descriptor = Object.getOwnPropertyDescriptor(Wallet.prototype, property);
      expect(descriptor?.get).toBeDefined();
      expect(descriptor?.set).toBeUndefined();
    }
  });
});
