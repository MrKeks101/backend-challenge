import { type BackoffConfig, backoffDelayMs, InvalidArgumentError } from "../../shared/kernel";
import type { WagerTransaction } from "./wager-transaction";

export interface PendingReferenceConfig extends BackoffConfig {
  /** Total de tentativas de reprocessamento antes de desistir. */
  maxAttempts: number;
  /** Idade máxima absoluta da pendência, em ms (freio de segurança). */
  ttlMs: number;
}

/**
 * Padrão: 10 tentativas com backoff 2s·2^n e teto de 5 min (≈ 18 min no total) e TTL de 1 h.
 * A defasagem esperada entre mensagens de um provedor é de segundos; ~18 min cobre incidentes
 * curtos sem manter pendências abertas indefinidamente.
 */
export const DEFAULT_PENDING_REFERENCE_CONFIG: PendingReferenceConfig = {
  maxAttempts: 10,
  baseMs: 2_000,
  capMs: 300_000,
  ttlMs: 3_600_000,
};

/** Falha cedo (na subida) se a configuração não produz um backoff válido. */
export function validatePendingReferenceConfig(config: PendingReferenceConfig): void {
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1) {
    throw new InvalidArgumentError("pending reference maxAttempts must be an integer >= 1");
  }
  if (!Number.isInteger(config.ttlMs) || config.ttlMs < 1) {
    throw new InvalidArgumentError("pending reference ttlMs must be a positive integer");
  }
  if (config.baseMs <= 0 || config.capMs < config.baseMs) {
    throw new InvalidArgumentError("pending reference backoff requires 0 < baseMs <= capMs");
  }
}

export type RetryDecision =
  | { action: "RETRY"; nextAttemptAt: Date }
  | { action: "GIVE_UP"; reason: "MAX_ATTEMPTS" | "TTL" };

/** Quando fazer a 1ª tentativa de reprocessamento, ao entrar em `PENDING_REFERENCE`. */
export function firstPendingReferenceAttemptAt(
  now: Date,
  config: PendingReferenceConfig = DEFAULT_PENDING_REFERENCE_CONFIG,
  jitter = 1,
): Date {
  return new Date(now.getTime() + backoffDelayMs(1, config, jitter));
}

/**
 * Decide o que fazer quando uma tentativa de reprocessamento AINDA não encontrou a referência.
 * `transaction.attempts` conta as tentativas fracassadas anteriores a esta.
 */
export function decideAfterFailedAttempt(
  transaction: WagerTransaction,
  now: Date,
  config: PendingReferenceConfig = DEFAULT_PENDING_REFERENCE_CONFIG,
  jitter = 1,
): RetryDecision {
  const failedAttempts = transaction.attempts + 1;
  if (now.getTime() - transaction.createdAt.getTime() >= config.ttlMs) {
    return { action: "GIVE_UP", reason: "TTL" };
  }
  if (failedAttempts >= config.maxAttempts) {
    return { action: "GIVE_UP", reason: "MAX_ATTEMPTS" };
  }
  return {
    action: "RETRY",
    nextAttemptAt: new Date(now.getTime() + backoffDelayMs(failedAttempts + 1, config, jitter)),
  };
}
