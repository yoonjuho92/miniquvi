import type {
  CatalogManifest,
  ColumnProfile,
  RelationGraph,
  TableProfile,
  TableSummary,
} from "./types";

/** TableProfile is a TableSummary plus more — extracting the summary is just field selection. */
export function summarizeProfile(p: TableProfile): TableSummary {
  return {
    schema: p.schema,
    name: p.name,
    kind: p.kind,
    comment: p.comment,
    rowCountEstimate: p.rowCountEstimate,
    columnCount: p.columns.length,
    primaryKey: p.primaryKey,
    foreignKeys: p.foreignKeys,
  };
}

/**
 * Renders the per-table markdown. Format is stable so the LLM and the loader
 * can both rely on it; if you change a section heading, update the loader too.
 */
export function renderTableMarkdown(p: TableProfile): string {
  const out: string[] = [];
  const fqn = `${p.schema}.${p.name}`;
  out.push(`# ${fqn}`);
  out.push("");
  out.push(`- Kind: \`${p.kind}\``);
  out.push(`- Approximate rows: ${formatRowCount(p.rowCountEstimate)}`);
  if (p.comment) out.push(`- Comment: ${p.comment}`);
  out.push("");

  out.push("## Columns");
  out.push("");
  out.push("| # | name | type | nullable | default | comment |");
  out.push("|---|------|------|----------|---------|---------|");
  for (const c of p.columns) {
    out.push(
      `| ${c.ordinalPosition} | \`${c.name}\` | \`${c.dataType}\` | ${
        c.isNullable ? "YES" : "NO"
      } | ${c.defaultExpr ? `\`${escapePipes(c.defaultExpr)}\`` : ""} | ${
        c.comment ? escapePipes(c.comment) : ""
      } |`,
    );
  }
  out.push("");

  if (p.primaryKey) {
    out.push("## Primary Key");
    out.push("");
    out.push(
      `- \`${p.primaryKey.name}\` on (${p.primaryKey.columns
        .map((c) => `\`${c}\``)
        .join(", ")})`,
    );
    out.push("");
  }

  if (p.foreignKeys.length) {
    out.push("## Foreign Keys");
    out.push("");
    for (const fk of p.foreignKeys) {
      const local = fk.columns.map((c) => `\`${c}\``).join(", ");
      const ref = fk.referencedColumns.map((c) => `\`${c}\``).join(", ");
      const actions = [
        fk.onUpdate ? `ON UPDATE ${fk.onUpdate}` : null,
        fk.onDelete ? `ON DELETE ${fk.onDelete}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      out.push(
        `- \`${fk.name}\`: (${local}) → \`${fk.referencedSchema}.${fk.referencedTable}\`(${ref})${
          actions ? ` — ${actions}` : ""
        }`,
      );
    }
    out.push("");
  }

  if (p.indexes.length) {
    out.push("## Indexes");
    out.push("");
    for (const ix of p.indexes) {
      const flags = [
        ix.isPrimary ? "PRIMARY" : null,
        ix.isUnique && !ix.isPrimary ? "UNIQUE" : null,
        ix.method ? ix.method : null,
      ]
        .filter(Boolean)
        .join(", ");
      out.push(
        `- \`${ix.name}\` (${flags}) on (${ix.columns.map((c) => `\`${c}\``).join(", ")})`,
      );
    }
    out.push("");
  }

  if (p.uniqueConstraints.length) {
    out.push("## Unique Constraints");
    out.push("");
    for (const u of p.uniqueConstraints) {
      out.push(
        `- \`${u.name}\` on (${u.columns.map((c) => `\`${c}\``).join(", ")})`,
      );
    }
    out.push("");
  }

  if (p.checkConstraints.length) {
    out.push("## Check Constraints");
    out.push("");
    for (const c of p.checkConstraints) {
      out.push(`- \`${c.name}\`: \`${escapeBackticks(c.expression)}\``);
    }
    out.push("");
  }

  out.push("## Sample Rows");
  out.push("");
  if (p.sampledSkipped) {
    out.push(`_Skipped: ${p.skipReason ?? "table too large"}_`);
    out.push("");
  } else if (p.sampleRows.length === 0) {
    out.push("_No rows._");
    out.push("");
  } else {
    out.push(renderRowsTable(p.columns.map((c) => c.name), p.sampleRows));
    out.push("");
  }

  out.push("## Column Profiles");
  out.push("");
  if (p.sampledSkipped) {
    out.push(`_Skipped: ${p.skipReason ?? "table too large"}_`);
    out.push("");
  } else {
    for (const cp of p.columnProfiles) {
      out.push(renderColumnProfile(cp));
    }
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function renderColumnProfile(cp: ColumnProfile): string {
  const lines: string[] = [];
  lines.push(`### \`${cp.column.name}\``);
  lines.push("");
  if (cp.stats) {
    if (cp.stats.min !== null) lines.push(`- min: \`${cp.stats.min}\``);
    if (cp.stats.max !== null) lines.push(`- max: \`${cp.stats.max}\``);
    if (cp.stats.avg !== null) lines.push(`- avg: \`${cp.stats.avg}\``);
    lines.push(`- null ratio: ${(cp.stats.nullRatio * 100).toFixed(1)}%`);
    if (cp.stats.distinctCount !== null) {
      lines.push(`- approx distinct: ${cp.stats.distinctCount}`);
    }
  }
  if (cp.distinctValues !== null) {
    const preview = cp.distinctValues
      .slice(0, 50)
      .map((v) => "`" + previewValue(v) + "`")
      .join(", ");
    lines.push(`- distinct values: ${preview || "_(none)_"}`);
  }
  if (lines.length === 2) {
    lines.push("- _no profile collected_");
  }
  lines.push("");
  return lines.join("\n");
}

function renderRowsTable(columns: string[], rows: Record<string, unknown>[]): string {
  const out: string[] = [];
  out.push(`| ${columns.map((c) => `\`${c}\``).join(" | ")} |`);
  out.push(`| ${columns.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    out.push(
      `| ${columns
        .map((c) => previewValue(row[c]))
        .map(escapePipes)
        .join(" | ")} |`,
    );
  }
  return out.join("\n");
}

export function renderTablesIndex(
  summaries: TableSummary[],
  mermaid: string,
  manifest: CatalogManifest,
): string {
  const out: string[] = [];
  out.push(`# Catalog: ${manifest.dialect}://${manifest.host}/${manifest.database}`);
  out.push("");
  out.push(`- Connection ID: \`${manifest.connectionId}\``);
  out.push(`- Built at: ${manifest.builtAt}`);
  out.push(`- Tables: ${summaries.length}`);
  out.push("");

  // Group by schema for readability when there are many tables.
  const bySchema = new Map<string, TableSummary[]>();
  for (const s of summaries) {
    const list = bySchema.get(s.schema) ?? [];
    list.push(s);
    bySchema.set(s.schema, list);
  }

  for (const [schema, list] of [...bySchema.entries()].sort()) {
    out.push(`## ${schema} (${list.length})`);
    out.push("");
    for (const s of list) {
      const summary = oneLineSummary(s);
      const rel = `tables/${s.schema}.${s.name}.md`;
      out.push(`- [\`${s.schema}.${s.name}\`](${rel}) — ${summary}`);
    }
    out.push("");
  }

  out.push("## Relations");
  out.push("");
  if (mermaid.trim()) {
    out.push("```mermaid");
    out.push(mermaid);
    out.push("```");
  } else {
    out.push("_No foreign keys discovered._");
  }
  out.push("");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function oneLineSummary(s: TableSummary): string {
  const parts: string[] = [];
  parts.push(`${s.kind}, ${formatRowCount(s.rowCountEstimate)}`);
  parts.push(`${s.columnCount} cols`);
  if (s.primaryKey) parts.push(`pk(${s.primaryKey.columns.join(",")})`);
  if (s.foreignKeys.length) parts.push(`${s.foreignKeys.length} fk`);
  const base = parts.join(" · ");
  return s.comment ? `${base} — ${truncate(s.comment, 120)}` : base;
}

/**
 * Mermaid `erDiagram` from the relation graph. Mermaid identifier rules are
 * picky (no dots, no quotes), so we sanitize node ids and only emit edges
 * where both sides are present in the graph.
 */
export function renderMermaidER(graph: RelationGraph): string {
  if (graph.edges.length === 0) return "";
  const lines: string[] = ["erDiagram"];
  const present = new Set(graph.nodes.map((n) => n.id));
  for (const e of graph.edges) {
    if (!present.has(e.from) || !present.has(e.to)) continue;
    const label = e.fromColumns.join(",");
    lines.push(`  ${mermaidId(e.to)} ||--o{ ${mermaidId(e.from)} : "${label}"`);
  }
  return lines.join("\n");
}

function mermaidId(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_");
}

function previewValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") {
    const s = v.replace(/\s+/g, " ").trim();
    return truncate(s, 60);
  }
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return String(v);
  }
  if (v instanceof Date) return v.toISOString();
  try {
    return truncate(JSON.stringify(v), 80);
  } catch {
    return String(v);
  }
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function escapeBackticks(s: string): string {
  return s.replace(/`/g, "\\`");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function formatRowCount(n: number): string {
  if (n < 0) return "unknown";
  if (n === 0) return "0";
  return `~${n.toLocaleString("en-US")}`;
}
