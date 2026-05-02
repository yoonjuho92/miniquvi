import type { ChatCompletionTool } from "openai/resources/chat/completions";
import {
  loadRelations,
  loadTableMarkdown,
  loadTableSummaries,
  type CatalogHandle,
} from "../../catalog";
import { executeReadOnlySql } from "../../sql";
import type { ConnectionConfig } from "../../db/introspect/types";

/** What the model sees in `tools`. */
export function makeAgentTools(): ChatCompletionTool[] {
  return [
    {
      type: "function",
      function: {
        name: "list_tables",
        description:
          "List every table in the catalog with one-line summaries. Use first when you don't know the schema. " +
          "`filter` is an optional case-insensitive substring of `schema.name`.",
        parameters: {
          type: "object",
          properties: {
            filter: { type: "string", description: "case-insensitive substring of `schema.name`" },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_table",
        description: "Get full metadata (columns, types, PK, FKs, sample) for one table.",
        parameters: {
          type: "object",
          properties: {
            schema: { type: "string" },
            name: { type: "string" },
          },
          required: ["schema", "name"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_relations",
        description:
          "Get foreign-key edges touching the given tables. Pass the tables you want to JOIN. " +
          "Pass an empty array to get the entire FK graph.",
        parameters: {
          type: "object",
          properties: {
            tables: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  schema: { type: "string" },
                  name: { type: "string" },
                },
                required: ["schema", "name"],
                additionalProperties: false,
              },
            },
          },
          required: ["tables"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_sql",
        description:
          "Execute a single read-only SQL query (SELECT / WITH / EXPLAIN / VALUES). " +
          "Returns up to ~25 rows back to you plus the full rowCount. DDL/DML are rejected.",
        parameters: {
          type: "object",
          properties: {
            sql: { type: "string" },
          },
          required: ["sql"],
          additionalProperties: false,
        },
      },
    },
  ];
}

export interface DispatchCtx {
  catalog: CatalogHandle;
  cfg: ConnectionConfig;
}

export interface DispatchResult {
  /** UI-side display payload (compact). */
  display: unknown;
  /** What we feed back to the model as the tool message content (must be a string). */
  modelContent: string;
  ok: boolean;
}

/** Rows shown to the model — kept small to bound token cost. */
const MODEL_ROW_PREVIEW = 25;
/** Rows shown to the user in the UI — bigger but still capped. */
const UI_ROW_PREVIEW = 50;
/** Hard cap on rows fetched from the DB per call. */
const ROW_CAP = 200;
const STATEMENT_TIMEOUT_MS = 15_000;

export async function dispatchTool(
  name: string,
  rawArgs: unknown,
  ctx: DispatchCtx,
): Promise<DispatchResult> {
  switch (name) {
    case "list_tables":
      return await listTablesTool(rawArgs, ctx);
    case "get_table":
      return await getTableTool(rawArgs, ctx);
    case "get_relations":
      return await getRelationsTool(rawArgs, ctx);
    case "run_sql":
      return await runSqlTool(rawArgs, ctx);
    default:
      return errorResult(`unknown tool "${name}"`);
  }
}

// ---------------------------------------------------------------------------
// individual tools
// ---------------------------------------------------------------------------

async function listTablesTool(
  rawArgs: unknown,
  ctx: DispatchCtx,
): Promise<DispatchResult> {
  const args = (rawArgs ?? {}) as { filter?: string };
  const all = await loadTableSummaries(ctx.catalog);
  const filter = args.filter?.toLowerCase().trim();
  const filtered = filter
    ? all.filter((t) => `${t.schema}.${t.name}`.toLowerCase().includes(filter))
    : all;
  const rows = filtered.map((t) => ({
    schema: t.schema,
    name: t.name,
    summary: t.summary,
  }));
  return {
    ok: true,
    display: {
      count: rows.length,
      filter: filter ?? null,
      sample: rows.slice(0, 8).map((r) => `${r.schema}.${r.name}`),
    },
    modelContent: JSON.stringify({ tables: rows, total: rows.length }),
  };
}

async function getTableTool(
  rawArgs: unknown,
  ctx: DispatchCtx,
): Promise<DispatchResult> {
  const args = (rawArgs ?? {}) as { schema?: string; name?: string };
  if (!args.schema || !args.name) {
    return errorResult("schema and name are required");
  }
  const md = await loadTableMarkdown(ctx.catalog, args.schema, args.name);
  if (!md) {
    return errorResult(`table "${args.schema}.${args.name}" not found in catalog`);
  }
  return {
    ok: true,
    display: { schema: args.schema, name: args.name, chars: md.length },
    modelContent: md,
  };
}

async function getRelationsTool(
  rawArgs: unknown,
  ctx: DispatchCtx,
): Promise<DispatchResult> {
  const args = (rawArgs ?? {}) as { tables?: { schema: string; name: string }[] };
  const graph = await loadRelations(ctx.catalog);
  if (!graph) {
    return {
      ok: true,
      display: { edges: [] },
      modelContent: JSON.stringify({ edges: [] }),
    };
  }
  const targets = new Set((args.tables ?? []).map((t) => `${t.schema}.${t.name}`));
  const edges = targets.size
    ? graph.edges.filter((e) => targets.has(e.from) || targets.has(e.to))
    : graph.edges;
  return {
    ok: true,
    display: { count: edges.length, requested: targets.size },
    modelContent: JSON.stringify({ edges }),
  };
}

async function runSqlTool(
  rawArgs: unknown,
  ctx: DispatchCtx,
): Promise<DispatchResult> {
  const args = (rawArgs ?? {}) as { sql?: string };
  if (!args.sql || !args.sql.trim()) {
    return errorResult("sql is required");
  }
  const result = await executeReadOnlySql(ctx.cfg, args.sql, {
    rowCap: ROW_CAP,
    timeoutMs: STATEMENT_TIMEOUT_MS,
  });
  if (!result.ok) {
    const message =
      result.errors.kind === "guard"
        ? `guard rejected: ${result.errors.details.map((d) => d.kind).join(",")}`
        : `execution error: ${result.errors.message}`;
    return {
      ok: false,
      display: { ok: false, sql: result.sql, error: message },
      modelContent: JSON.stringify({ ok: false, error: message }),
    };
  }
  const cols = result.columns.map((c) => c.name);
  return {
    ok: true,
    display: {
      ok: true,
      sql: result.sql,
      columns: cols,
      rows: result.rows.slice(0, UI_ROW_PREVIEW),
      rowCount: result.rowCount,
      truncated: result.truncated,
      durationMs: result.durationMs,
    },
    modelContent: JSON.stringify({
      ok: true,
      columns: cols,
      rows: result.rows.slice(0, MODEL_ROW_PREVIEW),
      rowCount: result.rowCount,
      truncated: result.truncated,
      shownToModel: Math.min(result.rows.length, MODEL_ROW_PREVIEW),
    }),
  };
}

function errorResult(message: string): DispatchResult {
  return {
    ok: false,
    display: { error: message },
    modelContent: JSON.stringify({ error: message }),
  };
}
