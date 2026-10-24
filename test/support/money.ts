import { Money } from "../../src/shared/kernel";

export const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
export const usd = (amount: string): Money => Money.from({ amount, currency: "USD" });

/** PRNG determinístico (mulberry32): testes de propriedade reproduzíveis, sem flakiness. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
