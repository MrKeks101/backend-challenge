import type { MigrationObject } from "@mikro-orm/core";
import { Migration20261024000001_core_tables } from "./Migration20261024000001_core_tables";
import { Migration20261024000002_integrity_triggers } from "./Migration20261024000002_integrity_triggers";

/**
 * Lista explícita e ordenada de migrations (sem varredura de diretório, que é frágil sob Bun).
 * Cada item é `{ name, class }`, com `name` no formato `MigrationYYYYMMDDHHMMSS_descricao`.
 * Migrations já aplicadas nunca são editadas: uma mudança nova é uma migration nova no fim.
 */
export const migrationsList: MigrationObject[] = [
  { name: "Migration20261024000001_core_tables", class: Migration20261024000001_core_tables },
  {
    name: "Migration20261024000002_integrity_triggers",
    class: Migration20261024000002_integrity_triggers,
  },
];
