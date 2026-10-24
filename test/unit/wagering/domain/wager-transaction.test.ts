import { describe, expect, test } from "bun:test";
import {
  DomainError,
  InvalidArgumentError,
  InvalidTransactionStateError,
} from "../../../../src/shared/kernel";
import {
  computePayloadHash,
  FailureCode,
  INTERNAL_PROVIDER_ID,
  InvalidWagerTransactionError,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  WagerTransaction,
} from "../../../../src/wagering/domain";
import { LedgerDirection } from "../../../../src/wallet/domain";
import { brl, usd } from "../../../support/money";
import { at, makeProcessed, makeTx, T0 } from "../../../support/wagering";

const ALL_STATUSES = Object.values(Status);

/** Leva uma transação nova até o estado pedido. */
function inStatus(status: Status): WagerTransaction {
  const withReference = { kind: Kind.Refund, referenceExternalTransactionId: "bet-1" } as const;
  const tx = makeTx(withReference);
  switch (status) {
    case Status.Pending:
      return tx;
    case Status.PendingReference:
      tx.markPendingReference(at(5));
      return tx;
    case Status.Processed:
      tx.markProcessed("ref-id", at(2), brl("75.00"));
      return tx;
    case Status.Rejected:
      tx.reject(FailureCode.AlreadyReversed, brl("75.00"), at(2));
      return tx;
    case Status.Failed:
      tx.fail(FailureCode.InternalPermanentError, at(2));
      return tx;
  }
}

describe("WagerTransaction.create — regras por kind (RF-TRX-03)", () => {
  test("nasce PENDING, sem tentativas, referência, falha nem saldo observado", () => {
    const tx = makeTx();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.attempts).toBe(0);
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.observedBalance).toBeUndefined();
    expect(tx.nextAttemptAt).toBeUndefined();
    expect(tx.isTerminal()).toBe(false);
  });

  test("OPENING é interno e não pode ser submetido (AR-11)", () => {
    expect(() => makeTx({ kind: Kind.Opening })).toThrow("OPENING is internal");
  });

  test.each([Kind.Bet, Kind.Win, Kind.Loss])("%s não exige referência", (kind) => {
    expect(() => makeTx({ kind })).not.toThrow();
  });

  test.each([Kind.Refund, Kind.Rollback])("%s exige referenceExternalTransactionId", (kind) => {
    expect(() => makeTx({ kind })).toThrow(InvalidWagerTransactionError);
    expect(() => makeTx({ kind, referenceExternalTransactionId: "bet-1" })).not.toThrow();
  });

  test("BET não pode ter referência", () => {
    expect(() => makeTx({ kind: Kind.Bet, referenceExternalTransactionId: "x" })).toThrow(
      "cannot have a reference",
    );
  });

  test.each([Kind.Win, Kind.Loss])("%s aceita referência opcional", (kind) => {
    expect(makeTx({ kind, referenceExternalTransactionId: "bet-1" }).requiresReference()).toBe(
      false,
    );
  });

  test("uma transação não pode referenciar a si mesma", () => {
    expect(() =>
      makeTx({
        kind: Kind.Refund,
        externalTransactionId: "same",
        referenceExternalTransactionId: "same",
      }),
    ).toThrow("reference itself");
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])(
    "%s exige valor positivo (zero é rejeitado)",
    (kind) => {
      const reference = kind === Kind.Refund || kind === Kind.Rollback ? "bet-1" : undefined;
      expect(() =>
        makeTx({ kind, money: brl("0.00"), referenceExternalTransactionId: reference }),
      ).toThrow(InvalidWagerTransactionError);
    },
  );

  test("LOSS aceita valor zero (registra o resultado sem mover saldo)", () => {
    expect(makeTx({ kind: Kind.Loss, money: brl("0.00") }).money.isZero()).toBe(true);
  });

  test.each(Object.values(Kind).filter((k) => k !== Kind.Opening))(
    "%s nunca aceita valor negativo",
    (kind) => {
      const reference = kind === Kind.Refund || kind === Kind.Rollback ? "bet-1" : undefined;
      expect(() =>
        makeTx({ kind, money: brl("1.00").negate(), referenceExternalTransactionId: reference }),
      ).toThrow("must not be negative");
    },
  );

  test("kind desconhecido é rejeitado", () => {
    expect(() => makeTx({ kind: "JACKPOT" as unknown as Kind })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test.each([
    ["providerId", { providerId: "" }],
    ["externalTransactionId", { externalTransactionId: " " }],
    ["idempotencyKey", { idempotencyKey: "" }],
    ["walletId", { walletId: "" }],
    ["playerId", { playerId: "" }],
    ["roundId", { roundId: "" }],
    ["gameId", { gameId: "" }],
    ["id", { id: "" }],
  ])("rejeita %s vazio", (_field, overrides) => {
    expect(() => makeTx(overrides)).toThrow(InvalidArgumentError);
  });

  test.each([
    "providerId",
    "externalTransactionId",
    "idempotencyKey",
    "roundId",
    "gameId",
  ] as const)("limita %s a 200 caracteres", (field) => {
    // idempotencyKey explícita: a derivada de externalTransactionId passaria do limite por si só
    const build = (size: number) => makeTx({ idempotencyKey: "k", [field]: "x".repeat(size) });
    expect(() => build(200)).not.toThrow();
    expect(() => build(201)).toThrow(InvalidArgumentError);
  });

  test("rejeita referência vazia e data inválida", () => {
    expect(() => makeTx({ kind: Kind.Win, referenceExternalTransactionId: " " })).toThrow(
      InvalidArgumentError,
    );
    expect(() => makeTx({ createdAt: new Date("x") })).toThrow(InvalidArgumentError);
  });

  test("a data de criação é copiada", () => {
    const createdAt = new Date(T0.getTime());
    const tx = makeTx({ createdAt });
    createdAt.setFullYear(1999);
    tx.createdAt.setFullYear(1999);
    expect(tx.createdAt.toISOString()).toBe(T0.toISOString());
  });
});

describe("WagerTransaction.createOpening — caminho interno", () => {
  const opening = () =>
    WagerTransaction.createOpening({
      id: "tx-open",
      walletId: "wallet-1",
      playerId: "player-1",
      money: brl("1000.00"),
      createdAt: T0,
    });

  test("usa o provider interno, key e external id derivados da wallet", () => {
    const tx = opening();
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.providerId).toBe(INTERNAL_PROVIDER_ID);
    expect(tx.externalTransactionId).toBe("wallet-1");
    expect(tx.idempotencyKey).toBe("opening:wallet-1");
    expect(tx.status).toBe(Status.Pending);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx.affectsBalance()).toBe(true);
  });

  test("exige valor positivo", () => {
    expect(() =>
      WagerTransaction.createOpening({
        id: "t",
        walletId: "w",
        playerId: "p",
        money: brl("0.00"),
        createdAt: T0,
      }),
    ).toThrow(InvalidWagerTransactionError);
  });
});

describe("payloadHash e idempotência (RF-API-09, AR-12)", () => {
  const base = {
    providerId: "provider-a",
    externalTransactionId: "tx-1",
    playerId: "player-1",
    walletId: "wallet-1",
    roundId: "round-1",
    gameId: "game",
    kind: Kind.Bet,
    money: brl("25.00"),
  };

  test("é SHA-256 hex e o create calcula o mesmo valor que computePayloadHash", () => {
    const tx = makeTx({ ...base });
    expect(tx.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tx.payloadHash).toBe(computePayloadHash(base));
  });

  test("não depende de id, idempotencyKey nem createdAt (metadados fora do hash)", () => {
    const one = makeTx({ ...base, id: "a", idempotencyKey: "k1", createdAt: at(0) });
    const two = makeTx({ ...base, id: "b", idempotencyKey: "k2", createdAt: at(999) });
    expect(one.payloadHash).toBe(two.payloadHash);
  });

  test("referência ausente e undefined produzem o mesmo hash; presente muda", () => {
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: undefined })).toBe(
      computePayloadHash(base),
    );
    expect(computePayloadHash({ ...base, referenceExternalTransactionId: "r" })).not.toBe(
      computePayloadHash(base),
    );
  });

  test.each([
    ["providerId", { providerId: "provider-b" }],
    ["externalTransactionId", { externalTransactionId: "tx-2" }],
    ["playerId", { playerId: "player-2" }],
    ["walletId", { walletId: "wallet-2" }],
    ["roundId", { roundId: "round-2" }],
    ["gameId", { gameId: "other" }],
    ["kind", { kind: Kind.Win }],
    ["valor", { money: brl("25.01") }],
    ["moeda", { money: usd("25.00") }],
  ])("muda quando %s muda", (_field, change) => {
    expect(computePayloadHash({ ...base, ...change })).not.toBe(computePayloadHash(base));
  });

  test("matchesPayload: mesmo payload casa, payload divergente não casa", () => {
    const tx = makeTx({ ...base });
    expect(tx.matchesPayload(computePayloadHash(base))).toBe(true);
    expect(tx.matchesPayload(computePayloadHash({ ...base, money: brl("26.00") }))).toBe(false);
    expect(tx.matchesPayload("")).toBe(false);
  });
});

describe("WagerTransaction — consultas de domínio", () => {
  test("affectsBalance é false só para LOSS", () => {
    for (const kind of Object.values(Kind).filter((k) => k !== Kind.Opening)) {
      const ref = kind === Kind.Refund || kind === Kind.Rollback ? "bet-1" : undefined;
      const tx = makeTx({ kind, money: brl("1.00"), referenceExternalTransactionId: ref });
      expect(tx.affectsBalance()).toBe(kind !== Kind.Loss);
    }
  });

  test("requiresReference é true só para REFUND e ROLLBACK", () => {
    expect(
      makeTx({ kind: Kind.Refund, referenceExternalTransactionId: "b" }).requiresReference(),
    ).toBe(true);
    expect(
      makeTx({ kind: Kind.Rollback, referenceExternalTransactionId: "b" }).requiresReference(),
    ).toBe(true);
    for (const kind of [Kind.Bet, Kind.Win, Kind.Loss]) {
      expect(makeTx({ kind }).requiresReference()).toBe(false);
    }
  });
});

describe("WagerTransaction.ledgerDirectionFor (RF-BIZ — direção inversa no ROLLBACK)", () => {
  const rollback = () => makeTx({ kind: Kind.Rollback, referenceExternalTransactionId: "ref" });

  test("BET debita; WIN e REFUND creditam", () => {
    expect(makeTx({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(makeTx({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(
      makeTx({ kind: Kind.Refund, referenceExternalTransactionId: "b" }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);
  });

  test("ROLLBACK de BET credita; de WIN debita; de REFUND debita", () => {
    expect(rollback().ledgerDirectionFor(makeProcessed({ kind: Kind.Bet }))).toBe(
      LedgerDirection.Credit,
    );
    expect(rollback().ledgerDirectionFor(makeProcessed({ kind: Kind.Win }))).toBe(
      LedgerDirection.Debit,
    );
    expect(
      rollback().ledgerDirectionFor(
        makeProcessed({ kind: Kind.Refund, referenceExternalTransactionId: "b" }),
      ),
    ).toBe(LedgerDirection.Debit);
  });

  test("ROLLBACK sem referência, ou de LOSS/ROLLBACK, não tem direção", () => {
    expect(() => rollback().ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    expect(() => rollback().ledgerDirectionFor(makeProcessed({ kind: Kind.Loss }))).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() =>
      rollback().ledgerDirectionFor(
        makeProcessed({ kind: Kind.Rollback, referenceExternalTransactionId: "b" }),
      ),
    ).toThrow(InvalidWagerTransactionError);
  });

  test("LOSS não tem direção", () => {
    expect(() => makeTx({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow("no ledger direction");
  });
});

describe("WagerTransaction — máquina de estados (RF-TRX-02, RF-TRX-04)", () => {
  type Attempt = (tx: WagerTransaction) => void;
  const attempts: [Status, Attempt][] = [
    [Status.PendingReference, (tx) => tx.markPendingReference(at(30))],
    [Status.Processed, (tx) => tx.markProcessed("ref-id", at(30), brl("1.00"))],
    [Status.Rejected, (tx) => tx.reject(FailureCode.AlreadyReversed, brl("1.00"), at(30))],
    [Status.Failed, (tx) => tx.fail(FailureCode.InternalPermanentError, at(30))],
  ];
  const allowed: Record<Status, Status[]> = {
    [Status.Pending]: [Status.PendingReference, Status.Processed, Status.Rejected, Status.Failed],
    [Status.PendingReference]: [
      Status.PendingReference,
      Status.Processed,
      Status.Rejected,
      Status.Failed,
    ],
    [Status.Processed]: [],
    [Status.Rejected]: [],
    [Status.Failed]: [],
  };

  for (const from of ALL_STATUSES) {
    for (const [to, attempt] of attempts) {
      const valid = allowed[from].includes(to);
      test(`${from} → ${to}: ${valid ? "permitida" : "proibida (InvalidTransactionStateError)"}`, () => {
        const tx = inStatus(from);
        if (valid) {
          attempt(tx);
          expect(tx.status).toBe(to);
        } else {
          expect(() => attempt(tx)).toThrow(InvalidTransactionStateError);
          expect(tx.status).toBe(from); // estado intacto
        }
      });
    }
  }

  test("PENDING não volta para PENDING: não existe transição para ele", () => {
    const names = Object.getOwnPropertyNames(WagerTransaction.prototype);
    expect(names).not.toContain("markPending");
  });

  test.each([Status.Processed, Status.Rejected, Status.Failed])(
    "%s é terminal e isTerminal() reflete isso",
    (status) => {
      expect(inStatus(status).isTerminal()).toBe(true);
    },
  );

  test.each([Status.Pending, Status.PendingReference])("%s não é terminal", (status) => {
    expect(inStatus(status).isTerminal()).toBe(false);
  });

  test("o erro de transição é de domínio, com code e estados", () => {
    const tx = inStatus(Status.Processed);
    try {
      tx.reject(FailureCode.AlreadyReversed, brl("1.00"), at(9));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const e = error as InvalidTransactionStateError;
      expect(e.code).toBe("INVALID_TRANSACTION_STATE");
      expect(e.from).toBe("PROCESSED");
      expect(e.to).toBe("REJECTED");
    }
  });

  test("uma transação terminal permanece idêntica após tentativas de mudança", () => {
    const tx = inStatus(Status.Processed);
    const before = { status: tx.status, processedAt: tx.processedAt?.toISOString() };
    for (const [, attempt] of attempts) expect(() => attempt(tx)).toThrow();
    expect({ status: tx.status, processedAt: tx.processedAt?.toISOString() }).toEqual(before);
  });
});

describe("WagerTransaction — markProcessed", () => {
  test("registra referência resolvida, saldo observado e instante terminal", () => {
    const tx = makeTx({ kind: Kind.Refund, referenceExternalTransactionId: "bet-1" });
    tx.markProcessed("bet-internal-id", at(3), brl("125.00"));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe("bet-internal-id");
    expect(tx.observedBalance?.toString()).toBe("125.00 BRL");
    expect(tx.processedAt?.toISOString()).toBe(at(3).toISOString());
    expect(tx.failureCode).toBeUndefined();
    expect(tx.nextAttemptAt).toBeUndefined();
  });

  test("a partir de PENDING_REFERENCE limpa o próximo agendamento", () => {
    const tx = inStatus(Status.PendingReference);
    expect(tx.nextAttemptAt).toBeDefined();
    tx.markProcessed("ref-id", at(9), brl("1.00"));
    expect(tx.nextAttemptAt).toBeUndefined();
  });

  test("REFUND/ROLLBACK precisam do id da referência resolvida", () => {
    const tx = makeTx({ kind: Kind.Refund, referenceExternalTransactionId: "bet-1" });
    expect(() => tx.markProcessed(undefined, at(1), brl("1.00"))).toThrow(
      InvalidWagerTransactionError,
    );
    expect(tx.status).toBe(Status.Pending);
  });

  test("transação sem referência não aceita id de referência", () => {
    const tx = makeTx({ kind: Kind.Bet });
    expect(() => tx.markProcessed("x", at(1), brl("1.00"))).toThrow(InvalidWagerTransactionError);
  });

  test("LOSS e BET processam sem referência", () => {
    const loss = makeTx({ kind: Kind.Loss });
    loss.markProcessed(undefined, at(1), brl("100.00"));
    expect(loss.status).toBe(Status.Processed);
  });

  test("o saldo observado deve estar na moeda da transação", () => {
    const tx = makeTx();
    expect(() => tx.markProcessed(undefined, at(1), usd("1.00"))).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test("data inválida é rejeitada sem alterar o estado", () => {
    const tx = makeTx();
    expect(() => tx.markProcessed(undefined, new Date("x"), brl("1.00"))).toThrow(
      InvalidArgumentError,
    );
    expect(tx.status).toBe(Status.Pending);
  });
});

describe("WagerTransaction — markPendingReference e tentativas", () => {
  test("a 1ª vez zera as tentativas e agenda a próxima", () => {
    const tx = makeTx({ kind: Kind.Refund, referenceExternalTransactionId: "bet-1" });
    tx.markPendingReference(at(2));
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.attempts).toBe(0);
    expect(tx.nextAttemptAt?.toISOString()).toBe(at(2).toISOString());
  });

  test("cada nova tentativa que não achou a referência soma 1 e reagenda", () => {
    const tx = makeTx({ kind: Kind.Refund, referenceExternalTransactionId: "bet-1" });
    tx.markPendingReference(at(2));
    tx.markPendingReference(at(6));
    tx.markPendingReference(at(14));
    expect(tx.attempts).toBe(2);
    expect(tx.nextAttemptAt?.toISOString()).toBe(at(14).toISOString());
  });

  test("só transações com referência podem aguardá-la", () => {
    const tx = makeTx({ kind: Kind.Bet });
    expect(() => tx.markPendingReference(at(2))).toThrow(InvalidWagerTransactionError);
    expect(tx.status).toBe(Status.Pending);
  });

  test("WIN com referência opcional informada também pode aguardar", () => {
    const tx = makeTx({ kind: Kind.Win, referenceExternalTransactionId: "bet-1" });
    tx.markPendingReference(at(2));
    expect(tx.status).toBe(Status.PendingReference);
  });

  test("nextAttemptAt devolve cópia", () => {
    const tx = inStatus(Status.PendingReference);
    tx.nextAttemptAt?.setFullYear(1999);
    expect(tx.nextAttemptAt?.toISOString()).toBe(at(5).toISOString());
  });
});

describe("WagerTransaction — reject e fail (códigos estáveis, RF-FC)", () => {
  const BUSINESS = [
    FailureCode.InsufficientFunds,
    FailureCode.ReversalWouldOverdraw,
    FailureCode.CurrencyMismatch,
    FailureCode.PlayerWalletMismatch,
    FailureCode.ReferenceNotFound,
    FailureCode.ReferenceNotProcessed,
    FailureCode.ReferenceMismatch,
    FailureCode.ReferenceKindNotAllowed,
    FailureCode.ReferenceAmountMismatch,
    FailureCode.AlreadyReversed,
    FailureCode.ReferenceAlreadyReversed,
  ];
  const TECHNICAL = [FailureCode.ProcessingRetriesExhausted, FailureCode.InternalPermanentError];

  test.each(BUSINESS)("reject aceita %s e guarda código, saldo observado e instante", (code) => {
    const tx = makeTx();
    tx.reject(code, brl("20.00"), at(4));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(code);
    expect(tx.observedBalance?.toString()).toBe("20.00 BRL");
    expect(tx.processedAt?.toISOString()).toBe(at(4).toISOString());
    expect(tx.referenceTransactionId).toBeUndefined();
  });

  test.each(TECHNICAL)("reject NÃO aceita o código técnico %s", (code) => {
    const tx = makeTx();
    expect(() => tx.reject(code, brl("1.00"), at(1))).toThrow(InvalidArgumentError);
    expect(tx.status).toBe(Status.Pending);
  });

  test.each(TECHNICAL)("fail aceita %s", (code) => {
    const tx = makeTx();
    tx.fail(code, at(4));
    expect(tx.status).toBe(Status.Failed);
    expect(tx.failureCode).toBe(code);
    expect(tx.observedBalance).toBeUndefined();
    expect(tx.processedAt?.toISOString()).toBe(at(4).toISOString());
  });

  test.each(BUSINESS)("fail NÃO aceita o código de negócio %s", (code) => {
    const tx = makeTx();
    expect(() => tx.fail(code, at(1))).toThrow(InvalidArgumentError);
    expect(tx.status).toBe(Status.Pending);
  });

  test("rejeição por referência inexistente parte de PENDING_REFERENCE", () => {
    const tx = inStatus(Status.PendingReference);
    tx.reject(FailureCode.ReferenceNotFound, brl("50.00"), at(900));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.nextAttemptAt).toBeUndefined();
  });

  test("o saldo observado na rejeição deve estar na moeda da transação", () => {
    expect(() => makeTx().reject(FailureCode.InsufficientFunds, usd("1.00"), at(1))).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe("WagerTransaction.rehydrate (RNF-MOD-02)", () => {
  const state = () => {
    const tx = inStatus(Status.Processed);
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      createdAt: tx.createdAt,
      status: tx.status,
      referenceTransactionId: tx.referenceTransactionId,
      failureCode: tx.failureCode,
      processedAt: tx.processedAt,
      observedBalance: tx.observedBalance,
      attempts: tx.attempts,
      nextAttemptAt: tx.nextAttemptAt,
    };
  };

  test("reconstrói o estado persistido sem alterá-lo", () => {
    const original = state();
    const tx = WagerTransaction.rehydrate(original);
    expect(tx.id).toBe(original.id);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.payloadHash).toBe(original.payloadHash);
    expect(tx.referenceTransactionId).toBe("ref-id");
    expect(tx.observedBalance?.toString()).toBe("75.00 BRL");
    expect(tx.isTerminal()).toBe(true);
  });

  test("NÃO revalida: aceita o que o banco entregou (p.ex. REFUND sem referência, valor zero)", () => {
    expect(() =>
      WagerTransaction.rehydrate({
        ...state(),
        kind: Kind.Refund,
        referenceExternalTransactionId: undefined,
        money: brl("0.00"),
        status: Status.Pending,
      }),
    ).not.toThrow();
  });

  test("não recalcula o hash: preserva o persistido", () => {
    const tx = WagerTransaction.rehydrate({ ...state(), payloadHash: "persistido" });
    expect(tx.payloadHash).toBe("persistido");
  });

  test("uma transação reidratada em estado terminal continua imutável", () => {
    const tx = WagerTransaction.rehydrate(state());
    expect(() => tx.fail(FailureCode.InternalPermanentError, at(9))).toThrow(
      InvalidTransactionStateError,
    );
  });

  test("uma reidratada em PENDING_REFERENCE continua a contagem de tentativas", () => {
    const tx = WagerTransaction.rehydrate({
      ...state(),
      status: Status.PendingReference,
      attempts: 3,
      nextAttemptAt: at(50),
      processedAt: undefined,
      referenceTransactionId: undefined,
      observedBalance: undefined,
    });
    tx.markPendingReference(at(80));
    expect(tx.attempts).toBe(4);
  });
});
