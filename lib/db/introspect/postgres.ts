import type { Pool, PoolClient, QueryResultRow } from "pg";
import { getPgPool } from "../pool";
import type {
  CheckConstraint,
  ColumnInfo,
  ColumnStats,
  ConnectionConfig,
  DbIntrospector,
  ForeignKey,
  IndexInfo,
  PrimaryKey,
  RelationKind,
  Row,
  SamplingOptions,
  Schema,
  SqlDialect,
  TableDetail,
  TableMeta,
  UniqueConstraint,
  ViewMeta,
} from "./types";

/**
 * PostgreSQL system schemas that are never useful as catalog content.
 * Subclasses (Supabase) extend this list.
 */
export const PG_SYSTEM_SCHEMAS = new Set([
  "pg_catalog",
  "information_schema",
  "pg_toast",
]);

const DEFAULT_SAMPLING_TIMEOUT_MS = 5_000;

interface PostgresIntrospectorOptions {
  /** Schemas to hide from `listSchemas`/`listTables` even when not strictly system. */
  extraHiddenSchemas?: Iterable<string>;
}

/**
 * Quote an identifier for safe inclusion in SQL we *generate* ourselves
 * (table/column names from `pg_catalog`). User-supplied values still go
 * through parameterized queries.
 */
function ident(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}

export class PostgresIntrospector implements DbIntrospector {
  readonly dialect: SqlDialect = "postgres";
  protected readonly pool: Pool;
  protected readonly hiddenSchemas: Set<string>;

  constructor(cfg: ConnectionConfig, opts: PostgresIntrospectorOptions = {}) {
    this.pool = getPgPool(cfg);
    this.hiddenSchemas = new Set(PG_SYSTEM_SCHEMAS);
    for (const s of opts.extraHiddenSchemas ?? []) this.hiddenSchemas.add(s);
  }

  /** Run a query within a short-lived transaction with statement_timeout applied. */
  protected async withTimeout<T>(
    timeoutMs: number,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      // SET LOCAL is wiped on COMMIT/ROLLBACK, so we don't poison the connection.
      await client.query("BEGIN READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1, timeoutMs)}`);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore — original error wins
      }
      throw err;
    } finally {
      client.release();
    }
  }

  protected async query<T extends QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(sql, params);
    return result.rows;
  }

  async listSchemas(): Promise<Schema[]> {
    const rows = await this.query<{ schema_name: string }>(
      `SELECT schema_name
         FROM information_schema.schemata
        ORDER BY schema_name`,
    );
    return rows.map((r) => ({
      name: r.schema_name,
      isSystem:
        this.hiddenSchemas.has(r.schema_name) ||
        // Per-session scratch schemas — irrelevant for catalog work.
        r.schema_name.startsWith("pg_temp_") ||
        r.schema_name.startsWith("pg_toast_temp_"),
    }));
  }

  async listTables(schema?: string): Promise<TableMeta[]> {
    const hidden = Array.from(this.hiddenSchemas);
    const rows = await this.query<{
      schema: string;
      name: string;
      relkind: string;
      reltuples: string;
      comment: string | null;
    }>(
      `SELECT n.nspname                              AS schema,
              c.relname                              AS name,
              c.relkind::text                        AS relkind,
              c.reltuples::bigint::text              AS reltuples,
              obj_description(c.oid, 'pg_class')     AS comment
         FROM pg_class      c
         JOIN pg_namespace  n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p','f','v','m')
          AND ($1::text IS NULL OR n.nspname = $1)
          AND ($1::text IS NOT NULL OR NOT (n.nspname = ANY($2::text[])))
        ORDER BY n.nspname, c.relname`,
      [schema ?? null, hidden],
    );
    return rows.map((r) => ({
      schema: r.schema,
      name: r.name,
      kind: relkindToRelationKind(r.relkind),
      rowCountEstimate: parseRelTuples(r.reltuples),
      comment: r.comment,
    }));
  }

  async listViews(schema?: string): Promise<ViewMeta[]> {
    const hidden = Array.from(this.hiddenSchemas);
    const rows = await this.query<{
      schema: string;
      name: string;
      relkind: string;
      reltuples: string;
      comment: string | null;
      definition: string | null;
    }>(
      `SELECT n.nspname                              AS schema,
              c.relname                              AS name,
              c.relkind::text                        AS relkind,
              c.reltuples::bigint::text              AS reltuples,
              obj_description(c.oid, 'pg_class')     AS comment,
              pg_get_viewdef(c.oid, true)            AS definition
         FROM pg_class      c
         JOIN pg_namespace  n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('v','m')
          AND ($1::text IS NULL OR n.nspname = $1)
          AND ($1::text IS NOT NULL OR NOT (n.nspname = ANY($2::text[])))
        ORDER BY n.nspname, c.relname`,
      [schema ?? null, hidden],
    );
    return rows.map((r) => ({
      schema: r.schema,
      name: r.name,
      kind: r.relkind === "m" ? "materialized_view" : "view",
      rowCountEstimate: parseRelTuples(r.reltuples),
      comment: r.comment,
      definition: r.definition,
    }));
  }

  async describeTable(schema: string, table: string): Promise<TableDetail> {
    const [meta, columns, primaryKey, foreignKeys, indexes, uniqueConstraints, checks] =
      await Promise.all([
        this.fetchRelationMeta(schema, table),
        this.fetchColumns(schema, table),
        this.fetchPrimaryKey(schema, table),
        this.fetchForeignKeys(schema, table),
        this.fetchIndexes(schema, table),
        this.fetchUniqueConstraints(schema, table),
        this.fetchCheckConstraints(schema, table),
      ]);

    if (!meta) {
      throw new Error(`relation not found: ${schema}.${table}`);
    }

    return {
      schema,
      name: table,
      kind: meta.kind,
      comment: meta.comment,
      columns,
      primaryKey,
      foreignKeys,
      indexes,
      uniqueConstraints,
      checkConstraints: checks,
    };
  }

  private async fetchRelationMeta(
    schema: string,
    table: string,
  ): Promise<{ kind: RelationKind; comment: string | null } | null> {
    const rows = await this.query<{ relkind: string; comment: string | null }>(
      `SELECT c.relkind::text AS relkind,
              obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class     c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, table],
    );
    const r = rows[0];
    if (!r) return null;
    return { kind: relkindToRelationKind(r.relkind), comment: r.comment };
  }

  private async fetchColumns(schema: string, table: string): Promise<ColumnInfo[]> {
    const rows = await this.query<{
      name: string;
      data_type: string;
      udt_name: string;
      is_nullable: boolean;
      default_expr: string | null;
      comment: string | null;
      ordinal_position: number;
    }>(
      `SELECT a.attname                                            AS name,
              format_type(a.atttypid, a.atttypmod)                 AS data_type,
              t.typname                                            AS udt_name,
              NOT a.attnotnull                                     AS is_nullable,
              pg_get_expr(ad.adbin, ad.adrelid)                    AS default_expr,
              col_description(c.oid, a.attnum)                     AS comment,
              a.attnum                                             AS ordinal_position
         FROM pg_attribute   a
         JOIN pg_class       c  ON c.oid = a.attrelid
         JOIN pg_namespace   n  ON n.oid = c.relnamespace
         JOIN pg_type        t  ON t.oid = a.atttypid
    LEFT JOIN pg_attrdef     ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
        WHERE n.nspname = $1
          AND c.relname = $2
          AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [schema, table],
    );
    return rows.map((r) => ({
      name: r.name,
      dataType: r.data_type,
      udtName: r.udt_name,
      isNullable: r.is_nullable,
      defaultExpr: r.default_expr,
      comment: r.comment,
      ordinalPosition: r.ordinal_position,
    }));
  }

  private async fetchPrimaryKey(
    schema: string,
    table: string,
  ): Promise<PrimaryKey | null> {
    const rows = await this.query<{ name: string; columns: string[] }>(
      `SELECT con.conname                                         AS name,
              array_agg(att.attname::text ORDER BY ord.ordinality)      AS columns
         FROM pg_constraint con
         JOIN pg_class      c   ON c.oid = con.conrelid
         JOIN pg_namespace  n   ON n.oid = c.relnamespace
         JOIN unnest(con.conkey) WITH ORDINALITY AS ord(attnum, ordinality) ON true
         JOIN pg_attribute  att ON att.attrelid = c.oid AND att.attnum = ord.attnum
        WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'p'
        GROUP BY con.conname`,
      [schema, table],
    );
    return rows[0] ?? null;
  }

  private async fetchForeignKeys(
    schema: string,
    table: string,
  ): Promise<ForeignKey[]> {
    const rows = await this.query<{
      name: string;
      columns: string[];
      ref_schema: string;
      ref_table: string;
      ref_columns: string[];
      on_update: string;
      on_delete: string;
    }>(
      `SELECT con.conname                                          AS name,
              (SELECT array_agg(att.attname::text ORDER BY ord.ordinality)
                 FROM unnest(con.conkey) WITH ORDINALITY ord(attnum, ordinality)
                 JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ord.attnum
              )                                                    AS columns,
              rn.nspname                                           AS ref_schema,
              rc.relname                                           AS ref_table,
              (SELECT array_agg(att.attname::text ORDER BY ord.ordinality)
                 FROM unnest(con.confkey) WITH ORDINALITY ord(attnum, ordinality)
                 JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = ord.attnum
              )                                                    AS ref_columns,
              con.confupdtype::text                                AS on_update,
              con.confdeltype::text                                AS on_delete
         FROM pg_constraint con
         JOIN pg_class      c   ON c.oid = con.conrelid
         JOIN pg_namespace  n   ON n.oid = c.relnamespace
         JOIN pg_class      rc  ON rc.oid = con.confrelid
         JOIN pg_namespace  rn  ON rn.oid = rc.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'f'
        ORDER BY con.conname`,
      [schema, table],
    );
    return rows.map((r) => ({
      name: r.name,
      columns: r.columns,
      referencedSchema: r.ref_schema,
      referencedTable: r.ref_table,
      referencedColumns: r.ref_columns,
      onUpdate: fkActionLabel(r.on_update),
      onDelete: fkActionLabel(r.on_delete),
    }));
  }

  private async fetchIndexes(schema: string, table: string): Promise<IndexInfo[]> {
    const rows = await this.query<{
      name: string;
      columns: string[];
      is_unique: boolean;
      is_primary: boolean;
      method: string | null;
    }>(
      `SELECT ic.relname                                              AS name,
              array_agg(att.attname::text ORDER BY ord.ordinality)          AS columns,
              ix.indisunique                                          AS is_unique,
              ix.indisprimary                                         AS is_primary,
              am.amname                                               AS method
         FROM pg_index      ix
         JOIN pg_class      tc  ON tc.oid = ix.indrelid
         JOIN pg_namespace  n   ON n.oid  = tc.relnamespace
         JOIN pg_class      ic  ON ic.oid = ix.indexrelid
         JOIN pg_am         am  ON am.oid = ic.relam
         JOIN unnest(ix.indkey) WITH ORDINALITY AS ord(attnum, ordinality) ON true
         JOIN pg_attribute  att ON att.attrelid = tc.oid AND att.attnum = ord.attnum
        WHERE n.nspname = $1 AND tc.relname = $2
        GROUP BY ic.relname, ix.indisunique, ix.indisprimary, am.amname
        ORDER BY ic.relname`,
      [schema, table],
    );
    return rows.map((r) => ({
      name: r.name,
      columns: r.columns,
      isUnique: r.is_unique,
      isPrimary: r.is_primary,
      method: r.method,
    }));
  }

  private async fetchUniqueConstraints(
    schema: string,
    table: string,
  ): Promise<UniqueConstraint[]> {
    const rows = await this.query<{ name: string; columns: string[] }>(
      `SELECT con.conname                                         AS name,
              array_agg(att.attname::text ORDER BY ord.ordinality)      AS columns
         FROM pg_constraint con
         JOIN pg_class      c   ON c.oid = con.conrelid
         JOIN pg_namespace  n   ON n.oid = c.relnamespace
         JOIN unnest(con.conkey) WITH ORDINALITY AS ord(attnum, ordinality) ON true
         JOIN pg_attribute  att ON att.attrelid = c.oid AND att.attnum = ord.attnum
        WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'u'
        GROUP BY con.conname
        ORDER BY con.conname`,
      [schema, table],
    );
    return rows;
  }

  private async fetchCheckConstraints(
    schema: string,
    table: string,
  ): Promise<CheckConstraint[]> {
    const rows = await this.query<{ name: string; expression: string }>(
      `SELECT con.conname                            AS name,
              pg_get_constraintdef(con.oid, true)    AS expression
         FROM pg_constraint con
         JOIN pg_class      c ON c.oid = con.conrelid
         JOIN pg_namespace  n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND con.contype = 'c'
        ORDER BY con.conname`,
      [schema, table],
    );
    return rows;
  }

  async sampleRows(
    schema: string,
    table: string,
    limit: number,
    options: SamplingOptions = {},
  ): Promise<Row[]> {
    const timeout = options.timeoutMs ?? DEFAULT_SAMPLING_TIMEOUT_MS;
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
    const target = `${ident(schema)}.${ident(table)}`;
    return this.withTimeout(timeout, async (client) => {
      const result = await client.query<Row>(
        `SELECT * FROM ${target} LIMIT ${safeLimit}`,
      );
      return result.rows;
    });
  }

  async distinctValues(
    schema: string,
    table: string,
    column: string,
    max: number,
    options: SamplingOptions = {},
  ): Promise<unknown[] | null> {
    const timeout = options.timeoutMs ?? DEFAULT_SAMPLING_TIMEOUT_MS;
    const cap = Math.min(Math.max(1, Math.floor(max)), 1000);
    const target = `${ident(schema)}.${ident(table)}`;
    const col = ident(column);
    return this.withTimeout(timeout, async (client) => {
      // Pull cap+1 to detect overflow without scanning the whole table.
      const result = await client.query<{ v: unknown }>(
        `SELECT DISTINCT ${col} AS v FROM ${target} WHERE ${col} IS NOT NULL LIMIT ${cap + 1}`,
      );
      if (result.rows.length > cap) return null;
      return result.rows.map((r) => r.v);
    });
  }

  async columnStats(
    schema: string,
    table: string,
    column: string,
    options: SamplingOptions = {},
  ): Promise<ColumnStats> {
    const timeout = options.timeoutMs ?? DEFAULT_SAMPLING_TIMEOUT_MS;
    const target = `${ident(schema)}.${ident(table)}`;
    const col = ident(column);

    return this.withTimeout(timeout, async (client) => {
      // Prefer pg_stats (sampled, no full scan) when present.
      const stats = await client.query<{
        null_frac: number | null;
        n_distinct: number | null;
      }>(
        `SELECT null_frac, n_distinct
           FROM pg_stats
          WHERE schemaname = $1 AND tablename = $2 AND attname = $3`,
        [schema, table, column],
      );

      const nullFrac = stats.rows[0]?.null_frac ?? null;
      const nDistinct = stats.rows[0]?.n_distinct ?? null;

      // For min/max/avg we still need the table; rely on statement_timeout
      // to bound the work on huge tables. Numeric/temporal types only — for
      // anything else we return nulls and let the caller skip.
      const colTypeRows = await client.query<{ category: string }>(
        `SELECT t.typcategory AS category
           FROM pg_attribute a
           JOIN pg_class     c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_type      t ON t.oid = a.atttypid
          WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3`,
        [schema, table, column],
      );
      const category = colTypeRows.rows[0]?.category ?? null;
      const isNumeric = category === "N";
      const isTemporal = category === "D";

      let min: string | null = null;
      let max: string | null = null;
      let avg: string | null = null;

      if (isNumeric || isTemporal) {
        const aggSelect = isNumeric
          ? `MIN(${col})::text AS min, MAX(${col})::text AS max, AVG(${col})::text AS avg`
          : `MIN(${col})::text AS min, MAX(${col})::text AS max, NULL::text AS avg`;
        const agg = await client.query<{
          min: string | null;
          max: string | null;
          avg: string | null;
        }>(`SELECT ${aggSelect} FROM ${target}`);
        min = agg.rows[0]?.min ?? null;
        max = agg.rows[0]?.max ?? null;
        avg = agg.rows[0]?.avg ?? null;
      }

      // n_distinct: positive => absolute count, negative => fraction of rows.
      // We only return positive values to avoid leaking the negative semantics.
      const distinctCount =
        nDistinct !== null && nDistinct >= 1 ? Math.round(nDistinct) : null;

      return {
        min,
        max,
        avg,
        nullRatio: nullFrac ?? 0,
        distinctCount,
      };
    });
  }

  async close(): Promise<void> {
    // Pool lifecycle is owned by the registry; closing here would break sharing.
    // Use closePgPool(cfg) when you really want to tear down.
  }
}

function relkindToRelationKind(relkind: string): RelationKind {
  switch (relkind) {
    case "r":
    case "p":
      return "table";
    case "v":
      return "view";
    case "m":
      return "materialized_view";
    case "f":
      return "foreign_table";
    default:
      return "table";
  }
}

function parseRelTuples(raw: string | null): number {
  if (!raw) return -1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return -1;
  // pg_class.reltuples is -1 when stats have never been collected.
  return n < 0 ? -1 : n;
}

function fkActionLabel(code: string | null): string | null {
  switch (code) {
    case "a":
      return "NO ACTION";
    case "r":
      return "RESTRICT";
    case "c":
      return "CASCADE";
    case "n":
      return "SET NULL";
    case "d":
      return "SET DEFAULT";
    default:
      return null;
  }
}
