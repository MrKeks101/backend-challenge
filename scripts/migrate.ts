/**
 * Executa as migrations. Uso: `bun run migration:up` / `bun run migration:down`.
 * Lê DATABASE_URL do ambiente (o Bun carrega o .env automaticamente).
 */
import { createOrm } from "../src/database/orm";
import { loadEnv } from "../src/shared/infrastructure/config/env";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  console.error("Uso: bun run scripts/migrate.ts <up|down>");
  process.exit(2);
}

const orm = await createOrm(loadEnv().DATABASE_URL, { poolMax: 2 });

try {
  const executed = direction === "up" ? await orm.migrator.up() : await orm.migrator.down();
  console.log(`${direction}: ${executed.length} migration(s) executada(s)`);
} finally {
  await orm.close(true);
}
