import type {
  ColumnInfo,
  ColumnStats,
  ForeignKey,
  IndexInfo,
  PrimaryKey,
  RelationKind,
  Row,
  SqlDialect,
  TableMeta,
  UniqueConstraint,
  CheckConstraint,
} from "../db/introspect/types";

export type { ForeignKey, PrimaryKey, RelationKind } from "../db/introspect/types";

/** Per-column profile written into the table md. */
export interface ColumnProfile {
  column: ColumnInfo;
  /** null when not collected (skipped — too many distinct values, or non-categorical). */
  distinctValues: unknown[] | null;
  /** null when not collected (non-numeric/temporal, or sampling skipped). */
  stats: ColumnStats | null;
}

export interface TableProfile {
  schema: string;
  name: string;
  kind: RelationKind;
  comment: string | null;
  rowCountEstimate: number;
  columns: ColumnInfo[];
  primaryKey: PrimaryKey | null;
  foreignKeys: ForeignKey[];
  indexes: IndexInfo[];
  uniqueConstraints: UniqueConstraint[];
  checkConstraints: CheckConstraint[];
  sampleRows: Row[];
  columnProfiles: ColumnProfile[];
  /** True when the table was treated as "huge" and we skipped sampling/stats. */
  sampledSkipped: boolean;
  skipReason?: string;
}

export interface RelationGraphNode {
  id: string; // "schema.name"
  schema: string;
  name: string;
  rowCountEstimate: number;
}

export interface RelationGraphEdge {
  id: string; // "<from>->{<to>}:<fkName>"
  from: string;
  to: string;
  fromColumns: string[];
  toColumns: string[];
  fkName: string;
}

export interface RelationGraph {
  nodes: RelationGraphNode[];
  edges: RelationGraphEdge[];
}

/**
 * Compact summary stored *inside* the manifest. With this, `ensureCatalog`
 * can rebuild `tables.md` and `relations.json` for cached tables without
 * making a single round-trip to the database.
 */
export interface TableSummary {
  schema: string;
  name: string;
  kind: RelationKind;
  comment: string | null;
  rowCountEstimate: number;
  columnCount: number;
  primaryKey: PrimaryKey | null;
  foreignKeys: ForeignKey[];
}

export interface CatalogManifestTableEntry extends TableSummary {
  /** Last time schema metadata (columns, FKs, indexes) was rebuilt. */
  schemaBuiltAt: string;
  /** Last time sample rows + column profiles were refreshed. Null when sampling was skipped. */
  samplesBuiltAt: string | null;
  /** Mirror of TableProfile.sampledSkipped — lets ensureCatalog decide whether to retry sampling. */
  sampledSkipped: boolean;
}

export interface CatalogManifest {
  connectionId: string;
  dialect: SqlDialect;
  host: string;
  database: string;
  builtAt: string;
  /** TTL hints used by the cache layer. May be overridden by env or BuilderOptions. */
  schemaTtlMs: number;
  sampleTtlMs: number;
  tables: CatalogManifestTableEntry[];
}

export interface BuilderOptions {
  /** Schemas to include explicitly. If omitted, every non-system schema is included. */
  schemas?: string[];
  /** Per-table sample size (rows). Default 5. */
  sampleRowLimit?: number;
  /** Max distinct values to enumerate for categorical columns. Default 50. */
  maxDistinctValues?: number;
  /** Skip sampling/stats for tables larger than this estimate. Default 5_000_000. */
  largeTableRowThreshold?: number;
  /** Per-query statement_timeout (ms) for sampling work. Default 5_000. */
  sampleTimeoutMs?: number;
  /** Concurrency for per-table profiling. Default 4. */
  concurrency?: number;
  /** Override catalog root. Defaults to env CATALOG_DIR or "<cwd>/.catalog". */
  catalogRoot?: string;
  /** Override schema TTL. Defaults to env CATALOG_SCHEMA_TTL_MS or 24h. */
  schemaTtlMs?: number;
  /** Override sample TTL. Defaults to env CATALOG_SAMPLE_TTL_MS or 1h. */
  sampleTtlMs?: number;
  /** Optional progress callback. */
  onProgress?: (event: BuilderProgress) => void;
}

export type BuilderProgress =
  | { kind: "schemas-listed"; schemas: string[] }
  | { kind: "tables-listed"; tables: TableMeta[] }
  | { kind: "plan"; build: number; reuse: number; drop: number }
  | { kind: "table-start"; schema: string; name: string }
  | {
      kind: "table-done";
      schema: string;
      name: string;
      durationMs: number;
      sampledSkipped: boolean;
    }
  | { kind: "table-reused"; schema: string; name: string }
  | { kind: "table-dropped"; schema: string; name: string }
  | { kind: "graph-built"; nodes: number; edges: number }
  | { kind: "written"; root: string }
  | { kind: "no-changes" };
