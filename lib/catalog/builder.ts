import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ColumnInfo,
  ConnectionConfig,
  DbIntrospector,
  TableMeta,
} from "../db/introspect/types";
import { connectionId } from "../db/pool";
import {
  catalogPaths,
  pruneStaleTableFiles,
  writeManifest,
  writeRelations,
  writeTableMarkdown,
  writeTablesIndex,
  type CatalogPaths,
} from "./writer";
import { summarizeProfile } from "./markdown";
import {
  planCacheUsage,
  resolveTtl,
  type TtlConfig,
} from "./cache";
import type {
  BuilderOptions,
  BuilderProgress,
  CatalogManifest,
  CatalogManifestTableEntry,
  ColumnProfile,
  RelationGraph,
  TableProfile,
  TableSummary,
} from "./types";

const DEFAULT_OPTIONS = {
  sampleRowLimit: 5,
  maxDistinctValues: 50,
  largeTableRowThreshold: 5_000_000,
  sampleTimeoutMs: 5_000,
  concurrency: 4,
} as const;

interface ResolvedOptions {
  sampleRowLimit: number;
  maxDistinctValues: number;
  largeTableRowThreshold: number;
  sampleTimeoutMs: number;
  concurrency: number;
  catalogRoot: string;
  schemas?: string[];
  ttl: TtlConfig;
  emit: (e: BuilderProgress) => void;
}

export interface BuildResult {
  paths: CatalogPaths;
  manifest: CatalogManifest;
  /** Profiles for tables that were actually rebuilt this run. */
  rebuilt: TableProfile[];
  /** Reused entries pulled straight from the prior manifest. */
  reused: CatalogManifestTableEntry[];
  graph: RelationGraph;
  noChanges: boolean;
}

export interface EnsureOptions extends BuilderOptions {
  /** When true, skip TTL checks and rebuild every live table. */
  force?: boolean;
}

/**
 * Idempotent catalog build. On a cache hit (every live table is fresh), this
 * touches no DB connections beyond a single `listTables` and produces no disk
 * writes — return is essentially a manifest read.
 */
export async function ensureCatalog(
  cfg: ConnectionConfig,
  introspector: DbIntrospector,
  opts: EnsureOptions = {},
): Promise<BuildResult> {
  const options = resolveOptions(opts);
  const id = connectionId(cfg);
  const paths = catalogPaths(options.catalogRoot, id);

  // Load existing manifest, if any. A failure here is treated as cache miss.
  const existing = await loadManifestOrNull(paths.manifest);

  // Step 1 — discover live tables (always; this is cheap)
  const liveTables = await listLiveTables(introspector, options);

  // Decide build/reuse/drop
  const plan = planCacheUsage({
    liveTables,
    manifest: existing,
    ttl: options.ttl,
    force: !!opts.force,
  });
  options.emit({
    kind: "plan",
    build: plan.build.length,
    reuse: plan.reuse.length,
    drop: plan.drop.length,
  });

  // Fast path: nothing to build, nothing to drop. Index/manifest already on disk.
  if (plan.build.length === 0 && plan.drop.length === 0 && existing) {
    options.emit({ kind: "no-changes" });
    const reused = plan.reuse.map((r) => r.entry);
    const graph = buildRelationGraphFromSummaries(reused);
    return {
      paths,
      manifest: existing,
      rebuilt: [],
      reused,
      graph,
      noChanges: true,
    };
  }

  // Steps 2 + 3 — describe + sample only the tables that need rebuilding
  const builtProfiles = await runWithConcurrency(
    plan.build,
    options.concurrency,
    async (table) => {
      options.emit({ kind: "table-start", schema: table.schema, name: table.name });
      const startedAt = Date.now();
      const profile = await profileTable(introspector, table, options);
      options.emit({
        kind: "table-done",
        schema: table.schema,
        name: table.name,
        durationMs: Date.now() - startedAt,
        sampledSkipped: profile.sampledSkipped,
      });
      return profile;
    },
  );

  for (const r of plan.reuse) {
    options.emit({ kind: "table-reused", schema: r.entry.schema, name: r.entry.name });
  }
  for (const d of plan.drop) {
    options.emit({ kind: "table-dropped", schema: d.schema, name: d.name });
  }

  // Step 4 — graph from the union of built + reused
  const summaries: TableSummary[] = [
    ...builtProfiles.map(summarizeProfile),
    ...plan.reuse.map((r) => entryToSummary(r.entry)),
  ].sort(compareSummaries);

  const graph = buildRelationGraphFromSummaries(summaries);
  options.emit({
    kind: "graph-built",
    nodes: graph.nodes.length,
    edges: graph.edges.length,
  });

  // Persist
  const now = new Date().toISOString();
  const reusedEntries = plan.reuse.map((r) => r.entry);
  const builtEntries = builtProfiles.map((p) => profileToEntry(p, now));
  const allEntries = [...builtEntries, ...reusedEntries].sort(compareEntries);

  const manifest: CatalogManifest = {
    connectionId: id,
    dialect: cfg.dialect,
    host: cfg.host || hostFromConnectionString(cfg.connectionString),
    database: cfg.database || databaseFromConnectionString(cfg.connectionString),
    builtAt: now,
    schemaTtlMs: options.ttl.schemaTtlMs,
    sampleTtlMs: options.ttl.sampleTtlMs,
    tables: allEntries,
  };

  // Only rewrite md files for tables we actually rebuilt — reused md is
  // already on disk and identical.
  await Promise.all(builtProfiles.map((p) => writeTableMarkdown(paths, p)));
  await writeRelations(paths, graph);
  await writeTablesIndex(paths, summaries, graph, manifest);
  await writeManifest(paths, manifest);
  await pruneStaleTableFiles(
    paths,
    summaries.map((s) => ({ schema: s.schema, name: s.name })),
  );
  options.emit({ kind: "written", root: paths.root });

  return {
    paths,
    manifest,
    rebuilt: builtProfiles,
    reused: reusedEntries,
    graph,
    noChanges: false,
  };
}

/**
 * Force-rebuild a single table (UI "refresh" button). Updates that table's
 * md and the aggregate index/graph; leaves every other table's cache intact.
 *
 * Returns null when the table no longer exists in the source DB — in that
 * case the catalog is reconciled too (md pruned, index regenerated).
 */
export async function refreshTable(
  cfg: ConnectionConfig,
  introspector: DbIntrospector,
  schema: string,
  name: string,
  opts: BuilderOptions = {},
): Promise<TableProfile | null> {
  const options = resolveOptions(opts);
  const id = connectionId(cfg);
  const paths = catalogPaths(options.catalogRoot, id);

  const existing = await loadManifestOrNull(paths.manifest);
  // listTables() is the source of truth for whether the table still exists.
  const liveInSchema = await introspector.listTables(schema);
  const target = liveInSchema.find((t) => t.name === name);

  if (!target) {
    // Table dropped from DB. Reconcile the catalog.
    if (existing) {
      const remaining = existing.tables.filter(
        (t) => !(t.schema === schema && t.name === name),
      );
      const summaries = remaining.map(entryToSummary).sort(compareSummaries);
      const graph = buildRelationGraphFromSummaries(summaries);
      const manifest: CatalogManifest = {
        ...existing,
        builtAt: new Date().toISOString(),
        tables: remaining.sort(compareEntries),
      };
      await writeRelations(paths, graph);
      await writeTablesIndex(paths, summaries, graph, manifest);
      await writeManifest(paths, manifest);
      await pruneStaleTableFiles(
        paths,
        summaries.map((s) => ({ schema: s.schema, name: s.name })),
      );
    }
    return null;
  }

  // Profile + persist this table only.
  const profile = await profileTable(introspector, target, options);
  await writeTableMarkdown(paths, profile);

  // Rebuild manifest entry; reuse everything else.
  const now = new Date().toISOString();
  const newEntry = profileToEntry(profile, now);
  const otherEntries = (existing?.tables ?? []).filter(
    (t) => !(t.schema === schema && t.name === name),
  );
  const allEntries = [...otherEntries, newEntry].sort(compareEntries);
  const summaries = allEntries.map(entryToSummary).sort(compareSummaries);
  const graph = buildRelationGraphFromSummaries(summaries);

  const manifest: CatalogManifest = {
    connectionId: id,
    dialect: cfg.dialect,
    host:
      existing?.host ??
      cfg.host ??
      hostFromConnectionString(cfg.connectionString),
    database:
      existing?.database ??
      cfg.database ??
      databaseFromConnectionString(cfg.connectionString),
    builtAt: now,
    schemaTtlMs: existing?.schemaTtlMs ?? options.ttl.schemaTtlMs,
    sampleTtlMs: existing?.sampleTtlMs ?? options.ttl.sampleTtlMs,
    tables: allEntries,
  };

  await writeRelations(paths, graph);
  await writeTablesIndex(paths, summaries, graph, manifest);
  await writeManifest(paths, manifest);
  return profile;
}

/**
 * Backwards-compatible alias: the original `buildCatalog` always rebuilt
 * everything, which is `ensureCatalog({ force: true })` in the new API.
 */
export async function buildCatalog(
  cfg: ConnectionConfig,
  introspector: DbIntrospector,
  opts: BuilderOptions = {},
): Promise<BuildResult> {
  return ensureCatalog(cfg, introspector, { ...opts, force: true });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function resolveOptions(opts: BuilderOptions): ResolvedOptions {
  return {
    sampleRowLimit: opts.sampleRowLimit ?? DEFAULT_OPTIONS.sampleRowLimit,
    maxDistinctValues: opts.maxDistinctValues ?? DEFAULT_OPTIONS.maxDistinctValues,
    largeTableRowThreshold:
      opts.largeTableRowThreshold ?? DEFAULT_OPTIONS.largeTableRowThreshold,
    sampleTimeoutMs: opts.sampleTimeoutMs ?? DEFAULT_OPTIONS.sampleTimeoutMs,
    concurrency: opts.concurrency ?? DEFAULT_OPTIONS.concurrency,
    catalogRoot:
      opts.catalogRoot ??
      process.env.CATALOG_DIR ??
      path.join(process.cwd(), ".catalog"),
    schemas: opts.schemas,
    ttl: resolveTtl({
      schemaTtlMs: opts.schemaTtlMs,
      sampleTtlMs: opts.sampleTtlMs,
    }),
    emit: (e: BuilderProgress) => opts.onProgress?.(e),
  };
}

async function listLiveTables(
  introspector: DbIntrospector,
  options: ResolvedOptions,
): Promise<TableMeta[]> {
  const allSchemas = await introspector.listSchemas();
  const targetSchemas = options.schemas?.length
    ? options.schemas
    : allSchemas.filter((s) => !s.isSystem).map((s) => s.name);
  options.emit({ kind: "schemas-listed", schemas: targetSchemas });
  const tableLists = await Promise.all(
    targetSchemas.map((s) => introspector.listTables(s)),
  );
  const tables = tableLists.flat();
  options.emit({ kind: "tables-listed", tables });
  return tables;
}

async function loadManifestOrNull(
  manifestPath: string,
): Promise<CatalogManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(raw) as CatalogManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Corrupt manifest → treat as cache miss; the rebuild will overwrite it.
    return null;
  }
}

async function profileTable(
  introspector: DbIntrospector,
  table: TableMeta,
  options: ResolvedOptions,
): Promise<TableProfile> {
  const detail = await introspector.describeTable(table.schema, table.name);

  // Skip sampling for "huge" tables to avoid blowing the timeout. We still
  // keep schema-level metadata.
  const skip =
    table.rowCountEstimate >= 0 &&
    table.rowCountEstimate > options.largeTableRowThreshold;

  if (skip) {
    return {
      schema: detail.schema,
      name: detail.name,
      kind: detail.kind,
      comment: detail.comment,
      rowCountEstimate: table.rowCountEstimate,
      columns: detail.columns,
      primaryKey: detail.primaryKey,
      foreignKeys: detail.foreignKeys,
      indexes: detail.indexes,
      uniqueConstraints: detail.uniqueConstraints,
      checkConstraints: detail.checkConstraints,
      sampleRows: [],
      columnProfiles: [],
      sampledSkipped: true,
      skipReason: `row estimate ${table.rowCountEstimate.toLocaleString("en-US")} > threshold ${options.largeTableRowThreshold.toLocaleString("en-US")}`,
    };
  }

  let sampleRows: Record<string, unknown>[] = [];
  let sampleSkipReason: string | undefined;
  try {
    sampleRows = await introspector.sampleRows(
      detail.schema,
      detail.name,
      options.sampleRowLimit,
      { timeoutMs: options.sampleTimeoutMs },
    );
  } catch (err) {
    sampleSkipReason = `sampleRows failed: ${(err as Error).message}`;
  }

  const columnProfiles = await Promise.all(
    detail.columns.map((c) =>
      profileColumn(introspector, detail.schema, detail.name, c, options),
    ),
  );

  return {
    schema: detail.schema,
    name: detail.name,
    kind: detail.kind,
    comment: detail.comment,
    rowCountEstimate: table.rowCountEstimate,
    columns: detail.columns,
    primaryKey: detail.primaryKey,
    foreignKeys: detail.foreignKeys,
    indexes: detail.indexes,
    uniqueConstraints: detail.uniqueConstraints,
    checkConstraints: detail.checkConstraints,
    sampleRows,
    columnProfiles,
    sampledSkipped: false,
    skipReason: sampleSkipReason,
  };
}

async function profileColumn(
  introspector: DbIntrospector,
  schema: string,
  table: string,
  column: ColumnInfo,
  options: { maxDistinctValues: number; sampleTimeoutMs: number },
): Promise<ColumnProfile> {
  const isLikelyCategorical =
    !/^(json|jsonb|bytea|text)$/.test(column.udtName) &&
    !/^(json|jsonb|bytea|text)$/.test(column.dataType);

  let distinctValues: unknown[] | null = null;
  if (isLikelyCategorical) {
    try {
      distinctValues = await introspector.distinctValues(
        schema,
        table,
        column.name,
        options.maxDistinctValues,
        { timeoutMs: options.sampleTimeoutMs },
      );
    } catch {
      distinctValues = null;
    }
  }

  let stats: ColumnProfile["stats"] = null;
  try {
    stats = await introspector.columnStats(schema, table, column.name, {
      timeoutMs: options.sampleTimeoutMs,
    });
  } catch {
    stats = null;
  }

  return { column, distinctValues, stats };
}

function buildRelationGraphFromSummaries(
  summaries: TableSummary[],
): RelationGraph {
  const nodes = summaries.map((s) => ({
    id: `${s.schema}.${s.name}`,
    schema: s.schema,
    name: s.name,
    rowCountEstimate: s.rowCountEstimate,
  }));
  const edges = summaries.flatMap((s) =>
    s.foreignKeys.map((fk) => ({
      id: `${s.schema}.${s.name}->${fk.referencedSchema}.${fk.referencedTable}:${fk.name}`,
      from: `${s.schema}.${s.name}`,
      to: `${fk.referencedSchema}.${fk.referencedTable}`,
      fromColumns: fk.columns,
      toColumns: fk.referencedColumns,
      fkName: fk.name,
    })),
  );
  return { nodes, edges };
}

function profileToEntry(
  p: TableProfile,
  now: string,
): CatalogManifestTableEntry {
  return {
    schema: p.schema,
    name: p.name,
    kind: p.kind,
    comment: p.comment,
    rowCountEstimate: p.rowCountEstimate,
    columnCount: p.columns.length,
    primaryKey: p.primaryKey,
    foreignKeys: p.foreignKeys,
    schemaBuiltAt: now,
    samplesBuiltAt: p.sampledSkipped ? null : now,
    sampledSkipped: p.sampledSkipped,
  };
}

function entryToSummary(e: CatalogManifestTableEntry): TableSummary {
  return {
    schema: e.schema,
    name: e.name,
    kind: e.kind,
    comment: e.comment,
    rowCountEstimate: e.rowCountEstimate,
    columnCount: e.columnCount,
    primaryKey: e.primaryKey,
    foreignKeys: e.foreignKeys,
  };
}

function compareSummaries(a: TableSummary, b: TableSummary): number {
  return a.schema === b.schema
    ? a.name.localeCompare(b.name)
    : a.schema.localeCompare(b.schema);
}

function compareEntries(
  a: CatalogManifestTableEntry,
  b: CatalogManifestTableEntry,
): number {
  return compareSummaries(a, b);
}

async function runWithConcurrency<T, U>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}

function hostFromConnectionString(s?: string): string {
  if (!s) return "";
  try {
    return new URL(s).hostname;
  } catch {
    return "";
  }
}
function databaseFromConnectionString(s?: string): string {
  if (!s) return "";
  try {
    return new URL(s).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
}
