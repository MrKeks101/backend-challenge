import { createHash } from "node:crypto";
import { canonicalize } from "./canonical-json";

/** SHA-256 em hexadecimal minúsculo (64 caracteres) de uma string UTF-8. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Hash de um valor via JSON canônico: independe da ordem das chaves. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalize(value));
}
