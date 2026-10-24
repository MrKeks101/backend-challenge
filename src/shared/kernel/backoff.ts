import { InvalidArgumentError } from "./errors";

export interface BackoffConfig {
  /** Espera da 1ª tentativa, em ms. */
  baseMs: number;
  /** Teto da espera exponencial (antes do jitter), em ms. */
  capMs: number;
}

/** Evita estourar a potência de 2 com `attempt` absurdo. */
const MAX_EXPONENT = 30;

/**
 * Backoff exponencial determinístico: `min(cap, base * 2^(attempt-1)) * jitter`.
 * `attempt` começa em 1. O `jitter` (p.ex. 0.8–1.2) é INJETADO por quem chama, mantendo a função
 * pura e testável; sem jitter, use 1.
 */
export function backoffDelayMs(attempt: number, config: BackoffConfig, jitter = 1): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new InvalidArgumentError("attempt must be an integer >= 1");
  }
  if (config.baseMs <= 0 || config.capMs < config.baseMs) {
    throw new InvalidArgumentError("backoff config requires 0 < baseMs <= capMs");
  }
  if (!Number.isFinite(jitter) || jitter <= 0) {
    throw new InvalidArgumentError("jitter must be a positive finite number");
  }
  const exponential = config.baseMs * 2 ** Math.min(attempt - 1, MAX_EXPONENT);
  return Math.round(Math.min(config.capMs, exponential) * jitter);
}
