import { InvalidArgumentError } from "./errors";

/**
 * Garante que o valor é JSON "puro": null, string, boolean, número finito, array e objeto simples,
 * recursivamente. Rejeita instâncias de classe (p.ex. `Money`, `Date`), `undefined`, `bigint`,
 * funções e símbolos. Usado para o `data` dos eventos e o payload da outbox, que precisam ser
 * estáveis e versionáveis: dinheiro viaja como `MoneyProps`, datas como ISO-8601.
 */
export function assertPlainJson(value: unknown, field: string, path = "$"): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new InvalidArgumentError(`${field}: non-finite number at ${path}`);
      }
      return;
    case "object": {
      if (Array.isArray(value)) {
        value.forEach((item, i) => {
          assertPlainJson(item, field, `${path}[${i}]`);
        });
        return;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new InvalidArgumentError(`${field}: non-plain object at ${path}`);
      }
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        assertPlainJson(nested, field, `${path}.${key}`);
      }
      return;
    }
    default:
      throw new InvalidArgumentError(`${field}: unsupported ${typeof value} at ${path}`);
  }
}

/** Congela o valor e tudo que ele contém (para `data` de eventos, que não deve mudar depois de criado). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
