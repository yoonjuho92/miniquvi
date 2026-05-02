import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CatalogManifest,
  RelationGraph,
  TableProfile,
  TableSummary,
} from "./types";
import { renderMermaidER, renderTableMarkdown, renderTablesIndex } from "./markdown";

export interface CatalogPaths {
  root: string;
  manifest: string;
  tablesIndex: string;
  relations: string;
  tablesDir: string;
  tableMd: (schema: string, name: string) => string;
}

export function catalogPaths(catalogRoot: string, connectionId: string): CatalogPaths {
  const root = path.join(catalogRoot, connectionId);
  return {
    root,
    manifest: path.join(root, "manifest.json"),
    tablesIndex: path.join(root, "tables.md"),
    relations: path.join(root, "relations.json"),
    tablesDir: path.join(root, "tables"),
    tableMd: (schema, name) =>
      path.join(root, "tables", `${schema}.${name}.md`),
  };
}

/** Atomic write: write to .tmp then rename, so a crash mid-write never leaves a partial file. */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

export async function writeTableMarkdown(
  paths: CatalogPaths,
  profile: TableProfile,
): Promise<void> {
  const md = renderTableMarkdown(profile);
  await writeFileAtomic(paths.tableMd(profile.schema, profile.name), md);
}

export async function writeTablesIndex(
  paths: CatalogPaths,
  summaries: TableSummary[],
  graph: RelationGraph,
  manifest: CatalogManifest,
): Promise<void> {
  const md = renderTablesIndex(summaries, renderMermaidER(graph), manifest);
  await writeFileAtomic(paths.tablesIndex, md);
}

export async function writeRelations(
  paths: CatalogPaths,
  graph: RelationGraph,
): Promise<void> {
  await writeFileAtomic(paths.relations, JSON.stringify(graph, null, 2));
}

export async function writeManifest(
  paths: CatalogPaths,
  manifest: CatalogManifest,
): Promise<void> {
  await writeFileAtomic(paths.manifest, JSON.stringify(manifest, null, 2));
}

/**
 * Remove markdown files for tables that no longer exist. Helps the catalog
 * shrink when a table is dropped from the source DB.
 */
export async function pruneStaleTableFiles(
  paths: CatalogPaths,
  keep: { schema: string; name: string }[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(paths.tablesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const allowed = new Set(keep.map((t) => `${t.schema}.${t.name}.md`));
  await Promise.all(
    entries
      .filter((f) => f.endsWith(".md") && !allowed.has(f))
      .map((f) => fs.unlink(path.join(paths.tablesDir, f)).catch(() => {})),
  );
}
