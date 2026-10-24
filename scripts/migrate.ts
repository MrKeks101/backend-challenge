/**
 * Executa as migrations. Uso: `bun run migration:up` / `bun run migration:down`.
 * Lê DATABASE_URL do ambiente (o Bun carrega o .env automaticamente).
 */
import { Migrator } from "@mikro-orm/migrations";
import { MikroORM } from "@mikro-orm/postgresql";
import { migrationsList } from "../migrations";
import { loadEnv } from "../src/shared/infrastructure/config/env";

const direction = process.argv[2];
if (direction !== "up" && direction !== "down") {
  console.error("Uso: bun run scripts/migrate.ts <up|down>");
  process.exit(2);
}

const env = loadEnv();
const orm = await MikroORM.init({
  clientUrl: env.DATABASE_URL,
  entities: [],
  extensions: [Migrator],
  // Migrations são SQL escrito à mão: sem snapshot de schema (.snapshot-*.json).
  migrations: { migrationsList, transactional: true, allOrNothing: true, snapshot: false },
  discovery: { warnWhenNoEntities: false },
});

try {
  const executed = direction === "up" ? await orm.migrator.up() : await orm.migrator.down();
  console.log(`${direction}: ${executed.length} migration(s) executada(s)`);
} finally {
  await orm.close(true);
}
