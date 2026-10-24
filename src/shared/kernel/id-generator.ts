import { v7 } from "uuid";

/** Gerador de identificadores injetável. */
export interface IdGenerator {
  next(): string;
}

/** UUIDv7: ordenável no tempo, bom para índices B-tree. */
export class Uuid7Generator implements IdGenerator {
  next(): string {
    return v7();
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
