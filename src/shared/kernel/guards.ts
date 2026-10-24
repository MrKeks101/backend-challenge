import { InvalidArgumentError } from "./errors";

/**
 * Garante string não vazia (sem contar espaços), com limite opcional de tamanho.
 * A mensagem cita só o nome do campo, nunca o valor.
 */
export function requireText(value: unknown, field: string, maxLength?: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidArgumentError(`${field} must be a non-empty string`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new InvalidArgumentError(`${field} must have at most ${maxLength} characters`);
  }
  return value;
}

/** Garante uma data válida e devolve uma CÓPIA, para que o chamador não consiga mutar o estado interno. */
export function requireDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidArgumentError(`${field} must be a valid Date`);
  }
  return new Date(value.getTime());
}
