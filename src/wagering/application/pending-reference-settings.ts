import type { PendingReferenceConfig } from "../domain";

export const PENDING_REFERENCE_SETTINGS = Symbol("PendingReferenceSettings");

/** Política de espera pela referência (limites e backoff) mais o jitter, injetável nos testes. */
export interface PendingReferenceSettings {
  policy: PendingReferenceConfig;
  /** Fator multiplicativo do backoff (p.ex. 0,8–1,2). */
  jitter: () => number;
}
