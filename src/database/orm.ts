import { Migrator } from "@mikro-orm/migrations";
import { MikroORM } from "@mikro-orm/postgresql";
import { migrationsList } from "../../migrations";
import { inboxTable, outboxTable } from "../messaging/infrastructure/persistence/tables";
import { type TableDef, toEntitySchema } from "../shared/infrastructure/persistence/table-def";
import { wagerTransactionsTable } from "../wagering/infrastructure/persistence/tables";
import { ledgerTable, walletsTable } from "../wallet/infrastructure/persistence/tables";

/** Todas as tabelas do sistema: fonte do ORM e do teste de divergência contra o banco. */
export const ALL_TABLES: readonly TableDef[] = [
  walletsTable,
  wagerTransactionsTable,
  ledgerTable,
  inboxTable,
  outboxTable,
];

export interface OrmOptions {
  poolMax?: number;
}

/**
 * Cria o MikroORM. As migrations são SQL à mão (D15), sem snapshot; os `EntitySchema` descrevem
 * o mapeamento e são conferidos contra o PostgreSQL real por teste.
 */
export function createOrm(databaseUrl: string, options: OrmOptions = {}): Promise<MikroORM> {
  return MikroORM.init({
    clientUrl: databaseUrl,
    entities: ALL_TABLES.map(toEntitySchema),
    extensions: [Migrator],
    migrations: { migrationsList, transactional: true, allOrNothing: true, snapshot: false },
    pool: { min: 2, max: options.poolMax ?? 10 },
    discovery: { warnWhenNoEntities: false },
  });
}
