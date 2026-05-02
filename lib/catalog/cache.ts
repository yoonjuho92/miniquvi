import type { TableMeta } from "../db/introspect/types";
import type {
  CatalogManifest,
  CatalogManifestTableEntry,
} from "./types";

/** Default TTLs — match the spec (24h schema, 1h samples). */
export const DEFAULT_SCHEMA_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SAMPLE_TTL_MS = 60 * 60 * 1000;

export interface TtlConfig {
  schemaTtlMs: number;
  sampleTtlMs: number;
}

/**
 * Resolve TTLs in priority order: explicit options → env vars → defaults.
 * Env: CATALOG_SCHEMA_TTL_MS, CATALOG_SAMPLE_TTL_MS.
 */
export function resolveTtl(opts: Partial<TtlConfig> = {}): TtlConfig {
  const fromEnv = (k: string) => {
    const v = process.env[k];
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  return {
    schemaTtlMs:
      opts.schemaTtlMs ??
      fromEnv("CATALOG_SCHEMA_TTL_MS") ??
      DEFAULT_SCHEMA_TTL_MS,
    sampleTtlMs:
      opts.sampleTtlMs ??
      fromEnv("CATALOG_SAMPLE_TTL_MS") ??
      DEFAULT_SAMPLE_TTL_MS,
  };
}

export type TableCacheDecision =
  | { action: "build"; reason: "missing" }
  | { action: "build"; reason: "schema-stale"; ageMs: number }
  | { action: "build"; reason: "samples-stale"; ageMs: number }
  | { action: "build"; reason: "samples-never" }
  | { action: "build"; reason: "forced" }
  | { action: "reuse"; entry: CatalogManifestTableEntry };

/**
 * Decide what to do with a single table given its manifest entry and current TTLs.
 * The decision is purely time-based — the introspector has not been called yet.
 */
export function decideTable(args: {
  entry: CatalogManifestTableEntry | undefined;
  now: number;
  ttl: TtlConfig;
  force: boolean;
}): TableCacheDecision {
  const { entry, now, ttl, force } = args;
  if (force) return { action: "build", reason: "forced" };
  if (!entry) return { action: "build", reason: "missing" };

  const schemaAge = now - Date.parse(entry.schemaBuiltAt);
  if (!Number.isFinite(schemaAge) || schemaAge > ttl.schemaTtlMs) {
    return { action: "build", reason: "schema-stale", ageMs: schemaAge };
  }

  // Samples: skipped tables are honored (don't keep retrying every run); the
  // explicit refresh path is what un-sticks them.
  if (!entry.sampledSkipped) {
    if (!entry.samplesBuiltAt) {
      return { action: "build", reason: "samples-never" };
    }
    const sampleAge = now - Date.parse(entry.samplesBuiltAt);
    if (!Number.isFinite(sampleAge) || sampleAge > ttl.sampleTtlMs) {
      return { action: "build", reason: "samples-stale", ageMs: sampleAge };
    }
  }

  return { action: "reuse", entry };
}

export interface CachePlan {
  build: TableMeta[];
  reuse: { table: TableMeta; entry: CatalogManifestTableEntry }[];
  drop: CatalogManifestTableEntry[];
}

/**
 * Cross-reference live tables (from the DB) with the manifest to produce a
 * three-way split: rebuild, reuse, drop.
 */
export function planCacheUsage(args: {
  liveTables: TableMeta[];
  manifest: CatalogManifest | null;
  ttl: TtlConfig;
  force: boolean;
  now?: number;
}): CachePlan {
  const now = args.now ?? Date.now();
  const entriesByKey = new Map<string, CatalogManifestTableEntry>();
  for (const e of args.manifest?.tables ?? []) {
    entriesByKey.set(`${e.schema}.${e.name}`, e);
  }

  const build: TableMeta[] = [];
  const reuse: { table: TableMeta; entry: CatalogManifestTableEntry }[] = [];
  const seen = new Set<string>();

  for (const t of args.liveTables) {
    const key = `${t.schema}.${t.name}`;
    seen.add(key);
    const decision = decideTable({
      entry: entriesByKey.get(key),
      now,
      ttl: args.ttl,
      force: args.force,
    });
    if (decision.action === "build") build.push(t);
    else reuse.push({ table: t, entry: decision.entry });
  }

  const drop: CatalogManifestTableEntry[] = [];
  for (const e of args.manifest?.tables ?? []) {
    if (!seen.has(`${e.schema}.${e.name}`)) drop.push(e);
  }

  return { build, reuse, drop };
}
