export const REDACTED = "[REDACTED]";

/**
 * Chaves que nunca vão para o log (AR-55): valores e saldos, o payload/corpo das requisições e
 * credenciais. Casa por trecho do nome, sem distinguir maiúsculas (`observedBalance`, `Amount`…).
 */
const SENSITIVE_KEY =
  /amount|balance|money|payload|body|difference|authorization|cookie|password|secret|token/i;

const MAX_DEPTH = 6;

/**
 * Cópia do valor com os campos sensíveis trocados por `[REDACTED]`, em qualquer profundidade. Erros
 * viram só `name`/`code`: a mensagem de um erro de banco pode trazer a linha inteira (inclui saldo).
 */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const { code } = value as { code?: unknown };
    return { name: value.name, ...(typeof code === "string" ? { code } : {}) };
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeForLog(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : sanitizeForLog(item, depth + 1),
    ]),
  );
}
