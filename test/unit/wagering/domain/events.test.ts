import { describe, expect, test } from "bun:test";
import { IntegrationEvent, InvalidArgumentError } from "../../../../src/shared/kernel";
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../../../src/wagering/domain";
import { LedgerDirection, WalletLedgerEntry } from "../../../../src/wallet/domain";
import { brl } from "../../../support/money";
import { at, eventContext, makeProcessed, makeTx, makeWallet, T0 } from "../../../support/wagering";

describe("WagerTransactionProcessed", () => {
  test("espelha a transação com dinheiro como MoneyProps e datas ISO", () => {
    const tx = makeProcessed({ kind: Kind.Win, money: brl("40.00") }, brl("140.00"));
    const event = WagerTransactionProcessed.from(tx, eventContext({ eventId: "e1" }));
    expect(event.eventType).toBe("WagerTransactionProcessed");
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(tx.id);
    expect(event.data).toMatchObject({
      transactionId: tx.id,
      walletId: "wallet-1",
      kind: "WIN",
      money: { amount: "40.00", currency: "BRL" },
      balance: { amount: "140.00", currency: "BRL" },
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      processedAt: at(1).toISOString(),
    });
  });

  test("inclui a referência resolvida", () => {
    const tx = makeTx({ kind: Kind.Refund, referenceExternalTransactionId: "bet-1" });
    tx.markProcessed("bet-id", at(2), brl("100.00"));
    const { data } = WagerTransactionProcessed.from(tx, eventContext());
    expect(data.referenceExternalTransactionId).toBe("bet-1");
    expect(data.referenceTransactionId).toBe("bet-id");
  });

  test("exige transação PROCESSED", () => {
    expect(() => WagerTransactionProcessed.from(makeTx(), eventContext())).toThrow(
      InvalidArgumentError,
    );
  });
});

describe("WagerTransactionRejected", () => {
  test("carrega failureCode e saldo observado", () => {
    const tx = makeTx({ money: brl("500.00") });
    tx.reject(FailureCode.InsufficientFunds, brl("100.00"), at(3));
    const event = WagerTransactionRejected.from(tx, eventContext());
    expect(event.eventType).toBe("WagerTransactionRejected");
    expect(event.data.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(event.data.balance.amount).toBe("100.00");
    expect(event.data.rejectedAt).toBe(at(3).toISOString());
  });

  test("exige transação REJECTED", () => {
    expect(() => WagerTransactionRejected.from(makeProcessed(), eventContext())).toThrow(
      InvalidArgumentError,
    );
  });
});

describe("WagerTransactionPendingReference", () => {
  test("carrega o próximo agendamento", () => {
    const tx = makeTx({ kind: Kind.Refund, referenceExternalTransactionId: "bet-1" });
    tx.markPendingReference(at(7));
    const event = WagerTransactionPendingReference.from(tx, eventContext());
    expect(event.eventType).toBe("WagerTransactionPendingReference");
    expect(event.data.nextAttemptAt).toBe(at(7).toISOString());
    expect(event.data.referenceExternalTransactionId).toBe("bet-1");
  });

  test("exige PENDING_REFERENCE", () => {
    expect(() => WagerTransactionPendingReference.from(makeTx(), eventContext())).toThrow(
      InvalidArgumentError,
    );
  });
});

describe("WagerTransactionFailed", () => {
  test("carrega o código técnico", () => {
    const tx = makeTx();
    tx.fail(FailureCode.ProcessingRetriesExhausted, at(9));
    const event = WagerTransactionFailed.from(tx, eventContext());
    expect(event.eventType).toBe("WagerTransactionFailed");
    expect(event.data.failureCode).toBe("PROCESSING_RETRIES_EXHAUSTED");
    expect(event.data.failedAt).toBe(at(9).toISOString());
  });

  test("exige FAILED", () => {
    expect(() => WagerTransactionFailed.from(makeTx(), eventContext())).toThrow(
      InvalidArgumentError,
    );
  });
});

describe("WalletBalanceChanged", () => {
  const applied = () => {
    const wallet = makeWallet("100.00");
    const entry = wallet.debit({
      entryId: "le-1",
      transactionId: "tx-1",
      money: brl("30.00"),
      at: at(5),
    });
    return { wallet, entry };
  };

  test("descreve a movimentação com antes/depois e versão da wallet", () => {
    const { wallet, entry } = applied();
    const event = WalletBalanceChanged.from(wallet, entry, eventContext());
    expect(event.eventType).toBe("WalletBalanceChanged");
    expect(event.aggregateId).toBe("wallet-1");
    expect(event.data).toEqual({
      walletId: "wallet-1",
      transactionId: "tx-1",
      direction: LedgerDirection.Debit,
      money: { amount: "30.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "70.00", currency: "BRL" },
      walletVersion: 2,
    });
  });

  test("recusa lançamento de outra wallet", () => {
    const { wallet } = applied();
    const foreign = WalletLedgerEntry.rehydrate({
      id: "le-x",
      walletId: "wallet-OUTRA",
      transactionId: "t",
      direction: LedgerDirection.Debit,
      money: brl("30.00"),
      balanceBefore: brl("100.00"),
      balanceAfter: brl("70.00"),
      createdAt: at(5),
    });
    expect(() => WalletBalanceChanged.from(wallet, foreign, eventContext())).toThrow(
      "does not belong",
    );
  });

  test("recusa saldo da wallet diferente do balanceAfter (evento nunca mente)", () => {
    const { entry } = applied();
    expect(() => WalletBalanceChanged.from(makeWallet("100.00"), entry, eventContext())).toThrow(
      "does not match",
    );
  });
});

describe("envelope IntegrationEvent", () => {
  const event = () =>
    WagerTransactionProcessed.from(
      makeProcessed(),
      eventContext({ eventId: "e-1", causationId: "msg-9" }),
    );

  test("toJSON contém o envelope completo e é serializável", () => {
    const built = event();
    const json = built.toJSON();
    expect(Object.keys(json).sort()).toEqual(
      [
        "aggregateId",
        "causationId",
        "correlationId",
        "data",
        "eventId",
        "eventType",
        "occurredAt",
        "version",
      ].sort(),
    );
    expect(json.occurredAt).toBe(at(10).toISOString());
    expect(JSON.parse(JSON.stringify(built))).toEqual(JSON.parse(JSON.stringify(json)));
  });

  test("causationId ausente não aparece no JSON", () => {
    const e = WagerTransactionProcessed.from(makeProcessed(), eventContext());
    expect("causationId" in e.toJSON()).toBe(false);
  });

  test("data é imutável e isolada da transação de origem", () => {
    const e = event();
    expect(Object.isFrozen(e.data)).toBe(true);
    expect(() => {
      (e.data as { balance: { amount: string } }).balance.amount = "0.00";
    }).toThrow();
  });

  test("occurredAt devolve cópia", () => {
    const e = event();
    e.occurredAt.setFullYear(1999);
    expect(e.occurredAt.toISOString()).toBe(at(10).toISOString());
  });

  test("rejeita ids vazios e data inválida", () => {
    const tx = makeProcessed();
    expect(() => WagerTransactionProcessed.from(tx, eventContext({ eventId: "" }))).toThrow(
      InvalidArgumentError,
    );
    expect(() => WagerTransactionProcessed.from(tx, eventContext({ correlationId: " " }))).toThrow(
      InvalidArgumentError,
    );
    expect(() =>
      WagerTransactionProcessed.from(tx, eventContext({ occurredAt: new Date("x") })),
    ).toThrow(InvalidArgumentError);
  });

  test("é instância de IntegrationEvent", () => {
    expect(event()).toBeInstanceOf(IntegrationEvent);
    expect(T0).toBeInstanceOf(Date);
  });
});
