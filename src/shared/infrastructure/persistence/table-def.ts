import { EntitySchema } from "@mikro-orm/core";

export type ColumnType =
  | "uuid"
  | "text"
  | "char"
  | "numeric"
  | "timestamptz"
  | "integer"
  | "bigint"
  | "jsonb";

export interface ColumnDef {
  /** Nome da coluna no banco (snake_case). */
  column: string;
  type: ColumnType;
  nullable?: boolean;
  primary?: boolean;
  /** `char(n)`. */
  length?: number;
  /** `numeric(p,s)`. */
  precision?: number;
  scale?: number;
  /** Preenchida pelo banco (identity): nunca vai no INSERT. */
  generated?: boolean;
}

export interface TableDef<P extends string = string> {
  readonly name: string;
  readonly entityName: string;
  readonly columns: Readonly<Record<P, ColumnDef>>;
}

/** Declara uma tabela. É a FONTE ÚNICA de nomes de coluna: SQL dos repositórios, `EntitySchema` e teste de divergência. */
export function defineTable<P extends string>(
  name: string,
  entityName: string,
  columns: Record<P, ColumnDef>,
): TableDef<P> {
  return Object.freeze({ name, entityName, columns: Object.freeze({ ...columns }) });
}

/** Colunas de dinheiro/identidade padrão. */
export const money = (column: string, opts: { nullable?: boolean } = {}): ColumnDef => ({
  column,
  type: "numeric",
  precision: 19,
  scale: 2,
  ...opts,
});

const entries = <P extends string>(def: TableDef<P>): [P, ColumnDef][] =>
  Object.entries(def.columns) as [P, ColumnDef][];

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/** `"coluna" AS "prop"` para todas as colunas, opcionalmente prefixadas por um alias de tabela. */
export function selectList(def: TableDef, alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  return entries(def)
    .map(([prop, col]) => `${prefix}${quote(col.column)} AS ${quote(prop)}`)
    .join(", ");
}

export interface BuiltStatement {
  sql: string;
  params: unknown[];
}

export interface InsertOptions {
  /** Texto após `ON CONFLICT`, p.ex. `(consumer_name, message_id)` ou vazio para qualquer unique. */
  onConflictDoNothing?: string;
  returning?: string;
}

/** INSERT parametrizado a partir do descritor. `undefined` vira NULL; `jsonb` é serializado. */
export function insertStatement<P extends string>(
  def: TableDef<P>,
  record: Partial<Record<P, unknown>>,
  options: InsertOptions = {},
): BuiltStatement {
  const columns = entries(def).filter(([, col]) => !col.generated);
  const params = columns.map(([prop, col]) => {
    const value = record[prop] ?? null;
    return col.type === "jsonb" && value !== null ? JSON.stringify(value) : value;
  });
  const placeholders = columns.map(([, col]) => (col.type === "jsonb" ? "?::jsonb" : "?"));
  let sql = `INSERT INTO ${quote(def.name)} (${columns.map(([, c]) => quote(c.column)).join(", ")}) VALUES (${placeholders.join(", ")})`;
  if (options.onConflictDoNothing !== undefined) {
    sql += ` ON CONFLICT ${options.onConflictDoNothing} DO NOTHING`;
  }
  if (options.returning) sql += ` RETURNING ${options.returning}`;
  return { sql, params };
}

const ORM_TYPES: Record<ColumnType, string> = {
  uuid: "uuid",
  text: "string",
  char: "string",
  numeric: "string", // nunca number: o driver devolve numeric como string
  timestamptz: "Date",
  integer: "number",
  bigint: "string",
  jsonb: "json",
};

/** Tipo SQL que o PostgreSQL deve reportar em `information_schema` para esta coluna. */
export function columnTypeSql(col: ColumnDef): string {
  switch (col.type) {
    case "char":
      return `char(${col.length})`;
    case "numeric":
      return `numeric(${col.precision},${col.scale})`;
    default:
      return col.type;
  }
}

/** `EntitySchema` do MikroORM gerado do descritor (só dados; o domínio não conhece isto). */
export function toEntitySchema<P extends string>(def: TableDef<P>): EntitySchema {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [prop, col] of entries(def)) {
    properties[prop] = {
      type: ORM_TYPES[col.type],
      fieldName: col.column,
      columnType: columnTypeSql(col),
      nullable: col.nullable ?? false,
      ...(col.primary ? { primary: true } : {}),
    };
  }
  return new EntitySchema({
    name: def.entityName,
    tableName: def.name,
    properties,
  } as ConstructorParameters<typeof EntitySchema>[0]);
}

const PG_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * O driver devolve `timestamptz` de SQL cru como texto (`2026-10-24 05:09:10.663757+00`). Converte
 * para `Date` (precisão de ms; o app só grava ms, então não há perda).
 */
export function parseTimestamptz(value: unknown): Date {
  if (value instanceof Date) return value;
  const match = typeof value === "string" ? PG_TIMESTAMP.exec(value) : null;
  if (!match) throw new Error("unexpected timestamptz value from the database");
  const [, date, time, fraction = "", zone = "Z"] = match;
  const millis = fraction.slice(0, 3).padEnd(3, "0");
  let offset = zone;
  if (zone !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    offset = `${zone[0]}${digits.slice(0, 2)}:${digits.slice(2, 4) || "00"}`;
  }
  const parsed = new Date(`${date}T${time}.${millis}${offset}`);
  if (Number.isNaN(parsed.getTime()))
    throw new Error("invalid timestamptz value from the database");
  return parsed;
}

/** Aplica ao registro (chaves = propriedades do descritor) as conversões que o driver não faz. */
export function coerceRecord<T>(def: TableDef, row: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...row };
  for (const [prop, col] of Object.entries(def.columns)) {
    if (col.type === "timestamptz" && out[prop] !== null && out[prop] !== undefined) {
      out[prop] = parseTimestamptz(out[prop]);
    }
  }
  return out as T;
}
