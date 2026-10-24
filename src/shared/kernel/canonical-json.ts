/**
 * JSON canônico para hashing determinístico (usado no `payloadHash` de idempotência).
 *
 * Regras (documentadas em ARCHITECTURE.md §6.1):
 * - sem espaços em branco;
 * - chaves de objeto ordenadas por ordem de unidade de código UTF-16, em todos os níveis;
 * - arrays preservam a ordem;
 * - strings serializadas como em `JSON.stringify`;
 * - valores aceitos: objeto simples, array, string, boolean, null e número finito;
 * - objetos com `toJSON()` (p.ex. `Money`, `Date`) são convertidos por ele antes;
 * - `undefined`, `NaN`, `Infinity`, `bigint`, função, símbolo e instâncias de classe sem `toJSON`
 *   são REJEITADOS: um campo ausente deve ser escrito explicitamente como `null` pelo chamador,
 *   para que "ausente" e "nulo" nunca produzam o mesmo hash por acidente.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalize: non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case "object":
      return serializeObject(value, path);
    default:
      throw new TypeError(`canonicalize: unsupported ${typeof value} at ${path}`);
  }
}

function serializeObject(value: object, path: string): string {
  const withToJson = value as { toJSON?: unknown };
  if (typeof withToJson.toJSON === "function") {
    return serialize((withToJson.toJSON as () => unknown).call(value), path);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, i) => serialize(item, `${path}[${i}]`)).join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`canonicalize: non-plain object at ${path}`);
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`)}`);
  return `{${entries.join(",")}}`;
}
