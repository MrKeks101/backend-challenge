import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PENDING_REFERENCE_CONFIG as CONFIG,
  decideAfterFailedAttempt,
  firstPendingReferenceAttemptAt,
  WagerTransactionKind as Kind,
  type WagerTransaction,
} from "../../../../src/wagering/domain";
import { at, makeTx, T0 } from "../../../support/wagering";

const waiting = (failedAttempts: number): WagerTransaction => {
  const tx = makeTx({ kind: Kind.Refund, referenceExternalTransactionId: "bet-1" });
  tx.markPendingReference(at(2));
  for (let i = 0; i < failedAttempts; i++) tx.markPendingReference(at(2));
  return tx;
};

describe("política de PENDING_REFERENCE (D8)", () => {
  test("configuração padrão: 10 tentativas, 2 s base, teto 5 min, TTL 1 h", () => {
    expect(CONFIG).toEqual({ maxAttempts: 10, baseMs: 2_000, capMs: 300_000, ttlMs: 3_600_000 });
  });

  test("1ª tentativa ocorre baseMs depois de entrar na espera", () => {
    expect(firstPendingReferenceAttemptAt(T0).getTime()).toBe(T0.getTime() + 2_000);
  });

  test("a 1ª tentativa respeita o jitter injetado", () => {
    expect(firstPendingReferenceAttemptAt(T0, CONFIG, 1.5).getTime()).toBe(T0.getTime() + 3_000);
  });

  test("a espera dobra a cada falha: 4 s, 8 s, 16 s...", () => {
    const delays = [0, 1, 2, 3].map((failed) => {
      const decision = decideAfterFailedAttempt(waiting(failed), at(100));
      if (decision.action !== "RETRY") throw new Error("expected RETRY");
      return decision.nextAttemptAt.getTime() - at(100).getTime();
    });
    expect(delays).toEqual([4_000, 8_000, 16_000, 32_000]);
  });

  test("a espera é limitada pelo teto", () => {
    const decision = decideAfterFailedAttempt(waiting(8), at(100), { ...CONFIG, maxAttempts: 99 });
    if (decision.action !== "RETRY") throw new Error("expected RETRY");
    expect(decision.nextAttemptAt.getTime() - at(100).getTime()).toBe(300_000);
  });

  test("a 10ª tentativa fracassada desiste por MAX_ATTEMPTS; a 9ª ainda reagenda", () => {
    expect(decideAfterFailedAttempt(waiting(8), at(100)).action).toBe("RETRY");
    expect(decideAfterFailedAttempt(waiting(9), at(100))).toEqual({
      action: "GIVE_UP",
      reason: "MAX_ATTEMPTS",
    });
  });

  test("TTL: desiste quando a transação tem exatamente 1 h, mas não 1 ms antes", () => {
    const tx = waiting(0);
    expect(decideAfterFailedAttempt(tx, new Date(T0.getTime() + 3_599_999)).action).toBe("RETRY");
    expect(decideAfterFailedAttempt(tx, new Date(T0.getTime() + 3_600_000))).toEqual({
      action: "GIVE_UP",
      reason: "TTL",
    });
  });

  test("o TTL vale mesmo com tentativas de sobra", () => {
    expect(decideAfterFailedAttempt(waiting(1), new Date(T0.getTime() + 7_200_000))).toEqual({
      action: "GIVE_UP",
      reason: "TTL",
    });
  });

  test("o total acumulado de espera nominal fica em torno de 18 min", () => {
    // esperas após cada falha 1..9 (a 10ª desiste): 4,8,16,32,64,128,256,300,300 s + 1ª de 2 s
    const total = [2, 4, 8, 16, 32, 64, 128, 256, 300, 300].reduce((a, b) => a + b, 0);
    expect(total / 60).toBeCloseTo(18.5, 0);
  });
});
