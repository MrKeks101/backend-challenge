import { describe, expect, test } from "bun:test";
import {
  FAILURE_CODES,
  FailureCode,
  ProviderAction,
  providerActionFor,
  REJECTION_CODES,
} from "../../../../src/wagering/domain";

const ALL = Object.values(FailureCode);

describe("taxonomia de failureCode", () => {
  test("os valores são os literais estáveis do contrato", () => {
    expect([...ALL].map(String).sort()).toEqual(
      [
        "INSUFFICIENT_FUNDS",
        "REVERSAL_WOULD_OVERDRAW",
        "CURRENCY_MISMATCH",
        "PLAYER_WALLET_MISMATCH",
        "REFERENCE_NOT_FOUND",
        "REFERENCE_NOT_PROCESSED",
        "REFERENCE_MISMATCH",
        "REFERENCE_KIND_NOT_ALLOWED",
        "REFERENCE_AMOUNT_MISMATCH",
        "ALREADY_REVERSED",
        "REFERENCE_ALREADY_REVERSED",
        "PROCESSING_RETRIES_EXHAUSTED",
        "INTERNAL_PERMANENT_ERROR",
      ].sort(),
    );
  });

  test("rejeição e falha particionam a taxonomia, sem sobreposição", () => {
    for (const code of ALL) {
      expect(REJECTION_CODES.has(code) !== FAILURE_CODES.has(code)).toBe(true);
    }
    expect(REJECTION_CODES.size + FAILURE_CODES.size).toBe(ALL.length);
  });

  test("todo código tem uma ação orientada ao provedor", () => {
    for (const code of ALL) {
      expect(Object.values(ProviderAction)).toContain(providerActionFor(code));
    }
  });

  test.each([
    [FailureCode.InsufficientFunds, ProviderAction.ResendAsNewTransaction],
    [FailureCode.CurrencyMismatch, ProviderAction.FixPayload],
    [FailureCode.AlreadyReversed, ProviderAction.GiveUp],
    [FailureCode.ReversalWouldOverdraw, ProviderAction.ManualResolution],
    [FailureCode.ProcessingRetriesExhausted, ProviderAction.RetrySameKey],
  ])("%s → %s", (code, action) => {
    expect(providerActionFor(code)).toBe(action);
  });
});
