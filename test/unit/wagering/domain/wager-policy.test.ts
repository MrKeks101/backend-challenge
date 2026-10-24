import { describe, expect, test } from "bun:test";
import { InvalidArgumentError, InvalidTransactionStateError } from "../../../../src/shared/kernel";
import {
  decideWagerOutcome,
  FailureCode,
  WagerTransactionKind as Kind,
  type WagerOutcome,
  type WagerTransaction,
  WagerTransactionStatus,
} from "../../../../src/wagering/domain";
import { LedgerDirection } from "../../../../src/wallet/domain";
import { brl, usd } from "../../../support/money";
import { at, makeProcessed, makeTx, makeWallet } from "../../../support/wagering";

const decide = (
  transaction: WagerTransaction,
  opts: {
    balance?: string;
    reference?: WagerTransaction | null;
    reversed?: boolean;
    playerId?: string;
  } = {},
): WagerOutcome =>
  decideWagerOutcome({
    transaction,
    wallet: makeWallet(opts.balance ?? "100.00", { playerId: opts.playerId ?? "player-1" }),
    reference: opts.reference ?? null,
    referenceAlreadyReversed: opts.reversed ?? false,
  });

const rejected = (code: FailureCode): WagerOutcome => ({ type: "REJECTED", code });
const processed = (
  direction: LedgerDirection | null,
  referenceTransactionId?: string,
): WagerOutcome => ({ type: "PROCESSED", direction, referenceTransactionId });

const bet = (ext = "bet-1") =>
  makeProcessed({ kind: Kind.Bet, externalTransactionId: ext, money: brl("25.00") });

describe("BET", () => {
  test("com saldo suficiente debita", () => {
    expect(decide(makeTx({ money: brl("25.00") }))).toEqual(processed(LedgerDirection.Debit));
  });

  test("saldo exatamente igual ao valor é aceito (esvazia a wallet)", () => {
    expect(decide(makeTx({ money: brl("100.00") }))).toEqual(processed(LedgerDirection.Debit));
  });

  test("um centavo acima do saldo é INSUFFICIENT_FUNDS", () => {
    expect(decide(makeTx({ money: brl("100.01") }))).toEqual(
      rejected(FailureCode.InsufficientFunds),
    );
  });

  test("wallet zerada rejeita", () => {
    expect(decide(makeTx({ money: brl("0.01") }), { balance: "0.00" })).toEqual(
      rejected(FailureCode.InsufficientFunds),
    );
  });
});

describe("WIN e LOSS", () => {
  test("WIN credita, sem exigir saldo", () => {
    expect(decide(makeTx({ kind: Kind.Win }), { balance: "0.00" })).toEqual(
      processed(LedgerDirection.Credit),
    );
  });

  test("LOSS processa sem lançamento (direction null) e sem tocar o saldo", () => {
    expect(decide(makeTx({ kind: Kind.Loss, money: brl("0.00") }), { balance: "0.00" })).toEqual(
      processed(null),
    );
  });

  test("LOSS processa mesmo com valor maior que o saldo", () => {
    expect(decide(makeTx({ kind: Kind.Loss, money: brl("500.00") }))).toEqual(processed(null));
  });

  test("WIN referenciando BET processada resolve a referência", () => {
    const ref = bet();
    const win = makeTx({ kind: Kind.Win, referenceExternalTransactionId: "bet-1" });
    expect(decide(win, { reference: ref })).toEqual(processed(LedgerDirection.Credit, ref.id));
  });

  test("WIN/LOSS referenciando algo que não é BET → REFERENCE_KIND_NOT_ALLOWED", () => {
    for (const kind of [Kind.Win, Kind.Loss]) {
      const win = makeProcessed({ kind: Kind.Win, externalTransactionId: "bet-1" });
      const tx = makeTx({ kind, money: brl("5.00"), referenceExternalTransactionId: "bet-1" });
      expect(decide(tx, { reference: win })).toEqual(rejected(FailureCode.ReferenceKindNotAllowed));
    }
  });

  test("WIN/LOSS cuja BET já foi estornada → REFERENCE_ALREADY_REVERSED (D7)", () => {
    for (const kind of [Kind.Win, Kind.Loss]) {
      const tx = makeTx({ kind, money: brl("5.00"), referenceExternalTransactionId: "bet-1" });
      expect(decide(tx, { reference: bet(), reversed: true })).toEqual(
        rejected(FailureCode.ReferenceAlreadyReversed),
      );
    }
  });
});

describe("REFUND", () => {
  const refund = (amount = "25.00") =>
    makeTx({ kind: Kind.Refund, money: brl(amount), referenceExternalTransactionId: "bet-1" });

  test("de BET processada credita e resolve a referência", () => {
    const ref = bet();
    expect(decide(refund(), { reference: ref })).toEqual(processed(LedgerDirection.Credit, ref.id));
  });

  test("sem a referência ainda → PENDING_REFERENCE", () => {
    expect(decide(refund(), { reference: null })).toEqual({ type: "PENDING_REFERENCE" });
  });

  test("valor diferente da referência → REFERENCE_AMOUNT_MISMATCH (RF-BIZ-05)", () => {
    expect(decide(refund("24.99"), { reference: bet() })).toEqual(
      rejected(FailureCode.ReferenceAmountMismatch),
    );
    expect(decide(refund("25.01"), { reference: bet() })).toEqual(
      rejected(FailureCode.ReferenceAmountMismatch),
    );
  });

  test("referência já estornada → ALREADY_REVERSED", () => {
    expect(decide(refund(), { reference: bet(), reversed: true })).toEqual(
      rejected(FailureCode.AlreadyReversed),
    );
  });

  test("só estorna BET: referenciar WIN → REFERENCE_KIND_NOT_ALLOWED", () => {
    const win = makeProcessed({ kind: Kind.Win, externalTransactionId: "bet-1" });
    expect(decide(refund(), { reference: win })).toEqual(
      rejected(FailureCode.ReferenceKindNotAllowed),
    );
  });
});

describe("ROLLBACK (direção inversa à da referência)", () => {
  const rollback = (amount: string) =>
    makeTx({ kind: Kind.Rollback, money: brl(amount), referenceExternalTransactionId: "ref-1" });

  test("de BET credita (devolve o débito)", () => {
    const ref = bet("ref-1");
    expect(decide(rollback("25.00"), { reference: ref })).toEqual(
      processed(LedgerDirection.Credit, ref.id),
    );
  });

  test("de WIN debita quando há saldo", () => {
    const win = makeProcessed({
      kind: Kind.Win,
      externalTransactionId: "ref-1",
      money: brl("40.00"),
    });
    expect(decide(rollback("40.00"), { reference: win, balance: "40.00" })).toEqual(
      processed(LedgerDirection.Debit, win.id),
    );
  });

  test("de WIN sem saldo → REVERSAL_WOULD_OVERDRAW (e não INSUFFICIENT_FUNDS)", () => {
    const win = makeProcessed({
      kind: Kind.Win,
      externalTransactionId: "ref-1",
      money: brl("40.00"),
    });
    expect(decide(rollback("40.00"), { reference: win, balance: "39.99" })).toEqual(
      rejected(FailureCode.ReversalWouldOverdraw),
    );
  });

  test("de REFUND debita (desfaz o crédito)", () => {
    const refund = makeProcessed({
      kind: Kind.Refund,
      externalTransactionId: "ref-1",
      referenceExternalTransactionId: "bet-1",
    });
    expect(decide(rollback("25.00"), { reference: refund })).toEqual(
      processed(LedgerDirection.Debit, refund.id),
    );
  });

  test("de LOSS e de ROLLBACK não são permitidos", () => {
    const loss = makeProcessed({
      kind: Kind.Loss,
      externalTransactionId: "ref-1",
      money: brl("0.00"),
    });
    const other = makeProcessed({
      kind: Kind.Rollback,
      externalTransactionId: "ref-1",
      referenceExternalTransactionId: "b",
    });
    expect(decide(rollback("25.00"), { reference: loss })).toEqual(
      rejected(FailureCode.ReferenceKindNotAllowed),
    );
    expect(decide(rollback("25.00"), { reference: other })).toEqual(
      rejected(FailureCode.ReferenceKindNotAllowed),
    );
  });

  test("valor diferente → REFERENCE_AMOUNT_MISMATCH; já estornada → ALREADY_REVERSED", () => {
    expect(decide(rollback("10.00"), { reference: bet("ref-1") })).toEqual(
      rejected(FailureCode.ReferenceAmountMismatch),
    );
    expect(decide(rollback("25.00"), { reference: bet("ref-1"), reversed: true })).toEqual(
      rejected(FailureCode.AlreadyReversed),
    );
  });
});

describe("estado da referência", () => {
  const refund = () =>
    makeTx({ kind: Kind.Refund, money: brl("25.00"), referenceExternalTransactionId: "bet-1" });
  const betIn = (prepare: (tx: WagerTransaction) => void) => {
    const tx = makeTx({ externalTransactionId: "bet-1" });
    prepare(tx);
    return tx;
  };

  test("referência PENDING ou PENDING_REFERENCE → continua aguardando", () => {
    expect(decide(refund(), { reference: betIn(() => {}) })).toEqual({
      type: "PENDING_REFERENCE",
    });
    const waiting = makeTx({
      kind: Kind.Win,
      externalTransactionId: "bet-1",
      referenceExternalTransactionId: "x",
    });
    waiting.markPendingReference(at(3));
    const asRef = makeTx({
      kind: Kind.Refund,
      referenceExternalTransactionId: "bet-1",
      money: brl("1.00"),
    });
    expect(decide(asRef, { reference: waiting })).toEqual(
      rejected(FailureCode.ReferenceKindNotAllowed),
    );
  });

  test("referência REJECTED ou FAILED → REFERENCE_NOT_PROCESSED", () => {
    const rejectedBet = betIn((tx) => tx.reject(FailureCode.InsufficientFunds, brl("0.00"), at(1)));
    const failedBet = betIn((tx) => tx.fail(FailureCode.InternalPermanentError, at(1)));
    expect(decide(refund(), { reference: rejectedBet })).toEqual(
      rejected(FailureCode.ReferenceNotProcessed),
    );
    expect(decide(refund(), { reference: failedBet })).toEqual(
      rejected(FailureCode.ReferenceNotProcessed),
    );
  });
});

describe("incompatibilidades com a wallet e a referência", () => {
  test("jogador diferente do dono da wallet → PLAYER_WALLET_MISMATCH", () => {
    expect(decide(makeTx(), { playerId: "player-2" })).toEqual(
      rejected(FailureCode.PlayerWalletMismatch),
    );
  });

  test("moeda diferente da wallet → CURRENCY_MISMATCH, sem olhar saldo", () => {
    expect(decide(makeTx({ money: usd("1.00") }))).toEqual(rejected(FailureCode.CurrencyMismatch));
  });

  test("tem precedência sobre referência ausente", () => {
    const tx = makeTx({
      kind: Kind.Refund,
      money: usd("1.00"),
      referenceExternalTransactionId: "bet-1",
    });
    expect(decide(tx)).toEqual(rejected(FailureCode.CurrencyMismatch));
  });

  test.each([
    ["outro provedor", { providerId: "provider-b" }],
    ["outro jogador", { playerId: "player-2" }],
    ["outra wallet", { walletId: "wallet-2" }],
    ["outra rodada", { roundId: "round-9" }],
  ])("referência de %s → REFERENCE_MISMATCH", (_label, change) => {
    const ref = makeProcessed({ externalTransactionId: "bet-1", ...change });
    const refund = makeTx({
      kind: Kind.Refund,
      money: brl("25.00"),
      referenceExternalTransactionId: "bet-1",
    });
    expect(decide(refund, { reference: ref })).toEqual(rejected(FailureCode.ReferenceMismatch));
  });

  test("referência de moeda diferente → REFERENCE_MISMATCH", () => {
    const ref = makeProcessed(
      { externalTransactionId: "bet-1", money: usd("25.00") },
      usd("75.00"),
    );
    const refund = makeTx({
      kind: Kind.Refund,
      money: brl("25.00"),
      referenceExternalTransactionId: "bet-1",
    });
    expect(decide(refund, { reference: ref })).toEqual(rejected(FailureCode.ReferenceMismatch));
  });

  test("um mismatch estático vence a espera: referência PENDING de outro jogador é rejeitada", () => {
    const ref = makeTx({ externalTransactionId: "bet-1", playerId: "player-2" });
    const refund = makeTx({
      kind: Kind.Refund,
      money: brl("25.00"),
      referenceExternalTransactionId: "bet-1",
    });
    expect(decide(refund, { reference: ref })).toEqual(rejected(FailureCode.ReferenceMismatch));
  });
});

describe("pré-condições (erros de programação, não desfechos de negócio)", () => {
  test("transação terminal não é decidida de novo", () => {
    expect(() => decide(makeProcessed())).toThrow(InvalidTransactionStateError);
  });

  test("wallet de outra transação lança", () => {
    expect(() =>
      decideWagerOutcome({
        transaction: makeTx({ walletId: "wallet-other" }),
        wallet: makeWallet(),
        reference: null,
        referenceAlreadyReversed: false,
      }),
    ).toThrow(InvalidArgumentError);
  });

  test("referência com outro externalTransactionId lança", () => {
    const refund = makeTx({
      kind: Kind.Refund,
      money: brl("25.00"),
      referenceExternalTransactionId: "bet-1",
    });
    expect(() => decide(refund, { reference: bet("outra") })).toThrow(InvalidArgumentError);
  });

  test("a decisão é pura: não altera transação nem wallet", () => {
    const tx = makeTx();
    const wallet = makeWallet();
    decideWagerOutcome({
      transaction: tx,
      wallet,
      reference: null,
      referenceAlreadyReversed: false,
    });
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(wallet.balance.toString()).toBe("100.00 BRL");
    expect(wallet.version).toBe(1);
  });
});
