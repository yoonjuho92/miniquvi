import { promises as fs } from "node:fs";
import path from "node:path";
import type { CatalogManifest, RelationGraph } from "./types";
import { catalogPaths, type CatalogPaths } from "./writer";

export interface CatalogHandle {
  paths: CatalogPaths;
  manifest: CatalogManifest;
}

export async function loadCatalog(
  catalogRoot: string,
  connectionId: string,
): Promise<CatalogHandle | null> {
  const paths = catalogPaths(catalogRoot, connectionId);
  const manifestRaw = await readFileOrNull(paths.manifest);
  if (!manifestRaw) return null;
  const manifest = JSON.parse(manifestRaw) as CatalogManifest;
  return { paths, manifest };
}

export async function loadTablesIndex(handle: CatalogHandle): Promise<string | null> {
  return readFileOrNull(handle.paths.tablesIndex);
}

export async function loadRelations(
  handle: CatalogHandle,
): Promise<RelationGraph | null> {
  const raw = await readFileOrNull(handle.paths.relations);
  return raw ? (JSON.parse(raw) as RelationGraph) : null;
}

export async function loadTableMarkdown(
  handle: CatalogHandle,
  schema: string,
  name: string,
): Promise<string | null> {
  return readFileOrNull(handle.paths.tableMd(schema, name));
}

/** Load several table mds in one shot — used to assemble the LLM context. */
export async function loadTableMarkdowns(
  handle: CatalogHandle,
  refs: { schema: string; name: string }[],
): Promise<{ schema: string; name: string; markdown: string }[]> {
  const results = await Promise.all(
    refs.map(async (ref) => {
      const md = await loadTableMarkdown(handle, ref.schema, ref.name);
      return md ? { schema: ref.schema, name: ref.name, markdown: md } : null;
    }),
  );
  return results.filter((r): r is { schema: string; name: string; markdown: string } =>
    r !== null,
  );
}

/** Cheap one-line summary per table, parsed straight out of `tables.md`. */
export async function loadTableSummaries(
  handle: CatalogHandle,
): Promise<{ schema: string; name: string; summary: string }[]> {
  const raw = await loadTablesIndex(handle);
  if (!raw) return [];
  const out: { schema: string; name: string; summary: string }[] = [];
  // Lines look like: `- [\`schema.table\`](tables/schema.table.md) — summary`
  const re = /^- \[`([^.`]+)\.([^`]+)`\]\([^)]+\) — (.+)$/gm;
  for (const m of raw.matchAll(re)) {
    out.push({ schema: m[1]!, name: m[2]!, summary: m[3]! });
  }
  return out;
}

async function readFileOrNull(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Lists connection_ids for which a catalog has been built. */
export async function listCatalogs(
  catalogRoot: string,
): Promise<{ connectionId: string; manifestPath: string }[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(catalogRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: { connectionId: string; manifestPath: string }[] = [];
  for (const entry of entries) {
    const manifestPath = path.join(catalogRoot, entry, "manifest.json");
    try {
      await fs.access(manifestPath);
      out.push({ connectionId: entry, manifestPath });
    } catch {
      // not a catalog dir
    }
  }
  return out;
}
