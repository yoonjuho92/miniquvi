/**
 * Common introspection types and the DbIntrospector adapter interface.
 *
 * The adapter pattern lets us add MySQL/SQL Server later without changing
 * the catalog builder or NL2SQL prompt logic.
 */

export type SqlDialect = "postgres" | "mysql" | "supabase";

export interface ConnectionConfig {
  dialect: SqlDialect;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  /** Optional connection string; when set, the fields above may be derived from it. */
  connectionString?: string;
}

export interface Schema {
  name: string;
  /** True for built-in / system schemas (pg_catalog, information_schema, etc.). */
  isSystem: boolean;
}

export type RelationKind = "table" | "view" | "materialized_view" | "foreign_table";

export interface TableMeta {
  schema: string;
  name: string;
  kind: RelationKind;
  /** Driver-side estimate (pg_class.reltuples / information_schema.table_rows). May be -1 if unknown. */
  rowCountEstimate: number;
  comment: string | null;
}

export interface ViewMeta extends TableMeta {
  kind: "view" | "materialized_view";
  definition: string | null;
}

export interface ColumnInfo {
  name: string;
  /** Normalized SQL type, e.g. "varchar(255)", "int4", "timestamptz". */
  dataType: string;
  /** Raw udt_name for advanced cases. */
  udtName: string;
  isNullable: boolean;
  defaultExpr: string | null;
  comment: string | null;
  ordinalPosition: number;
}

export interface PrimaryKey {
  name: string;
  columns: string[];
}

export interface ForeignKey {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  onUpdate: string | null;
  onDelete: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  /** Driver-specific (e.g. "btree", "hash"). */
  method: string | null;
}

export interface UniqueConstraint {
  name: string;
  columns: string[];
}

export interface CheckConstraint {
  name: string;
  expression: string;
}

export interface TableDetail {
  schema: string;
  name: string;
  kind: RelationKind;
  comment: string | null;
  columns: ColumnInfo[];
  primaryKey: PrimaryKey | null;
  foreignKeys: ForeignKey[];
  indexes: IndexInfo[];
  uniqueConstraints: UniqueConstraint[];
  checkConstraints: CheckConstraint[];
}

export type Row = Record<string, unknown>;

export interface ColumnStats {
  /** Min/max/avg are stringified to keep numeric, date, and bigint values losslessly representable. */
  min: string | null;
  max: string | null;
  avg: string | null;
  nullRatio: number;
  /** Approximate distinct count when cheaply available; otherwise null. */
  distinctCount: number | null;
}

export interface SamplingOptions {
  /** Statement-level timeout in ms applied to every sampling query. */
  timeoutMs?: number;
}

/**
 * Adapter-level contract every dialect implements. Keep this surface minimal —
 * higher-level concerns (catalog building, caching, markdown rendering) live
 * outside the adapter and call into these methods.
 */
export interface DbIntrospector {
  readonly dialect: SqlDialect;

  listSchemas(): Promise<Schema[]>;

  listTables(schema?: string): Promise<TableMeta[]>;

  listViews(schema?: string): Promise<ViewMeta[]>;

  describeTable(schema: string, table: string): Promise<TableDetail>;

  sampleRows(
    schema: string,
    table: string,
    limit: number,
    options?: SamplingOptions,
  ): Promise<Row[]>;

  /**
   * Returns up to `max` distinct values for a column, or `null` when the
   * distinct count is too high to enumerate cheaply (treat as "not categorical").
   */
  distinctValues(
    schema: string,
    table: string,
    column: string,
    max: number,
    options?: SamplingOptions,
  ): Promise<unknown[] | null>;

  columnStats(
    schema: string,
    table: string,
    column: string,
    options?: SamplingOptions,
  ): Promise<ColumnStats>;

  /** Release any underlying resources (pool, sockets). Idempotent. */
  close(): Promise<void>;
}
