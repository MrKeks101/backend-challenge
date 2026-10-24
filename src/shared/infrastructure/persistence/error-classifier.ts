import { DomainError } from "../../kernel";
import { OptimisticLockError } from "./errors";

/**
 * - `BUSINESS`: regra de domínio violada; o desfecho é determinístico (rejeitar), nunca repetir.
 * - `TRANSIENT`: pode passar sozinho (lock, deadlock, timeout, conexão); repetir com backoff.
 * - `PERMANENT`: repetir não ajuda (constraint, tipo inválido, bug); falhar de forma auditável.
 */
export type ErrorKind = "BUSINESS" | "TRANSIENT" | "PERMANENT";

export interface ErrorClassification {
  kind: ErrorKind;
  /** Motivo curto e seguro para log/métrica (sem dados do jogador). */
  reason: string;
  sqlState?: string;
}

/** SQLSTATEs transitórios (https://www.postgresql.org/docs/current/errcodes-appendix.html). */
const TRANSIENT_STATES = new Map<string, string>([
  ["40001", "serialization_failure"],
  ["40P01", "deadlock_detected"],
  ["55P03", "lock_not_available"],
  ["57014", "query_canceled"],
  ["57P01", "admin_shutdown"],
  ["57P02", "crash_shutdown"],
  ["57P03", "cannot_connect_now"],
  ["53000", "insufficient_resources"],
  ["53100", "disk_full"],
  ["53200", "out_of_memory"],
  ["53300", "too_many_connections"],
  ["53400", "configuration_limit_exceeded"],
]);

/** Códigos de rede do Node/Bun para falhas de conexão. */
const TRANSIENT_NETWORK = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ConnectionRefused",
  "ConnectionClosed",
]);

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** Procura o SQLSTATE no erro e em suas causas (o ORM embrulha o erro do driver). */
function findCode(error: unknown, depth = 0): string | undefined {
  if (typeof error !== "object" || error === null || depth > 4) return undefined;
  const candidate = (error as { code?: unknown }).code;
  if (
    typeof candidate === "string" &&
    (SQLSTATE.test(candidate) || TRANSIENT_NETWORK.has(candidate))
  ) {
    return candidate;
  }
  return findCode((error as { cause?: unknown }).cause, depth + 1);
}

export function classifyError(error: unknown): ErrorClassification {
  if (error instanceof DomainError) return { kind: "BUSINESS", reason: error.code };
  if (error instanceof OptimisticLockError) return { kind: "TRANSIENT", reason: "optimistic_lock" };

  const code = findCode(error);
  if (code === undefined) return { kind: "PERMANENT", reason: "unclassified" };
  if (TRANSIENT_NETWORK.has(code))
    return { kind: "TRANSIENT", reason: "connection", sqlState: code };

  const transient = TRANSIENT_STATES.get(code);
  if (transient) return { kind: "TRANSIENT", reason: transient, sqlState: code };
  // Classe 08: falha de conexão.
  if (code.startsWith("08"))
    return { kind: "TRANSIENT", reason: "connection_exception", sqlState: code };
  // Classe 23: violação de integridade; 22: dado inválido; 42: sintaxe/objeto ausente.
  return { kind: "PERMANENT", reason: `sqlstate_${code}`, sqlState: code };
}

export const isTransient = (error: unknown): boolean => classifyError(error).kind === "TRANSIENT";
