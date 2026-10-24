import type { MigrationObject } from "@mikro-orm/core";

/**
 * Lista explícita e ordenada de migrations (sem varredura de diretório, que é frágil sob Bun).
 * Cada item é `{ name, class }`, com `name` no formato `MigrationYYYYMMDDHHMMSS_descricao`.
 * O schema real entra no M5.
 */
export const migrationsList: MigrationObject[] = [];
