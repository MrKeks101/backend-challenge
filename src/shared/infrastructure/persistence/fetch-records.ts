import type { EntityManager } from "@mikro-orm/postgresql";
import { coerceRecord, type TableDef } from "./table-def";

/** Executa um SELECT/RETURNING que usa `selectList(def)` e devolve registros já coerentes (datas como `Date`). */
export async function fetchRecords<T>(
  em: EntityManager,
  def: TableDef,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const rows = await em.execute<Record<string, unknown>[]>(sql, params);
  return rows.map((row) => coerceRecord<T>(def, row));
}
