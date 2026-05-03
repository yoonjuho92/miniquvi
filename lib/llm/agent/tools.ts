import type { ChatCompletionTool } from "openai/resources/chat/completions";
import {
  loadRelations,
  loadTableMarkdown,
  loadTableSummaries,
  type CatalogHandle,
} from "../../catalog";
import { executeReadOnlySql } from "../../sql";
import type { ConnectionConfig } from "../../db/introspect/types";
import { createReport } from "../../report";

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
        name: "make_plan",
        description:
          "Sketch a short numbered plan BEFORE other tool calls. Use only for non-trivial questions (3+ tables, comparisons across timeframes, multi-aggregation reports). Skip for one-shot lookups. The plan is recorded in the conversation; you can revise by calling `make_plan` again.",
        parameters: {
          type: "object",
          properties: {
            goal: {
              type: "string",
              description: "Restated user goal in one sentence.",
            },
            steps: {
              type: "array",
              items: { type: "string" },
              description: "Ordered, concrete steps. 2–6 items.",
            },
          },
          required: ["goal", "steps"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "render_report",
        description:
          "Render an HTML report from structured sections. Use when the user asks for a 보고서 / report / 요약본, or when results span several queries that benefit from a polished document. Returns a URL the user can open. Call AFTER you've gathered every number you need — DO NOT invent values.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            subtitle: { type: "string" },
            summary: {
              type: "string",
              description:
                "Executive summary, 1–3 short paragraphs. Markdown allowed: **bold**, *italic*, `code`, lists.",
            },
            kpis: {
              type: "array",
              description: "Up to 8 headline metrics rendered as cards.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  value: { type: "string" },
                  hint: { type: "string" },
                },
                required: ["label", "value"],
                additionalProperties: false,
              },
            },
            sections: {
              type: "array",
              description: "Body sections in order. At least one.",
              items: {
                type: "object",
                properties: {
                  heading: { type: "string" },
                  body: {
                    type: "string",
                    description: "Optional prose. Markdown allowed.",
                  },
                  table: {
                    type: "object",
                    properties: {
                      caption: { type: "string" },
                      columns: {
                        type: "array",
                        items: { type: "string" },
                      },
                      rows: {
                        type: "array",
                        description:
                          "Each row is an array of pre-formatted strings aligned with `columns`. Stringify numbers (e.g. \"1,234\", \"45.6%\") and dates yourself before passing.",
                        items: {
                          type: "array",
                          items: { type: "string" },
                        },
                      },
                    },
                    required: ["columns", "rows"],
                    additionalProperties: false,
                  },
                  chart: {
                    type: "object",
                    description:
                      "A Chart.js chart rendered inline. Use raw numeric values (NOT formatted strings) in `datasets[].data`. Pick the type per the rule: `bar` for category comparison, `line` for time series, `doughnut`/`pie` for share-of-total. Stacked bars require `stacked: true` AND parts that sum to a meaningful total.",
                    properties: {
                      type: {
                        type: "string",
                        enum: ["bar", "line", "pie", "doughnut"],
                      },
                      title: { type: "string" },
                      labels: {
                        type: "array",
                        description:
                          "X-axis tick labels (bar/line) or slice labels (pie/doughnut). Length must equal `datasets[].data.length`.",
                        items: { type: "string" },
                      },
                      datasets: {
                        type: "array",
                        description:
                          "One entry per series. For pie/doughnut only the first dataset is used. Each `data[i]` is the raw number for `labels[i]`.",
                        items: {
                          type: "object",
                          properties: {
                            label: { type: "string" },
                            data: {
                              type: "array",
                              items: { type: "number" },
                            },
                          },
                          required: ["label", "data"],
                          additionalProperties: false,
                        },
                      },
                      stacked: { type: "boolean" },
                      xAxisLabel: { type: "string" },
                      yAxisLabel: { type: "string" },
                    },
                    required: ["type", "labels", "datasets"],
                    additionalProperties: false,
                  },
                },
                required: ["heading"],
                additionalProperties: false,
              },
            },
          },
          required: ["title", "sections"],
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
    case "make_plan":
      return await makePlanTool(rawArgs);
    case "render_report":
      return await renderReportTool(rawArgs);
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

async function makePlanTool(rawArgs: unknown): Promise<DispatchResult> {
  const args = (rawArgs ?? {}) as { goal?: unknown; steps?: unknown };
  const goal = typeof args.goal === "string" ? args.goal.trim() : "";
  const stepsRaw = Array.isArray(args.steps) ? args.steps : [];
  const steps = stepsRaw
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim());
  if (!goal || steps.length === 0) {
    return errorResult("make_plan needs a non-empty `goal` and at least one step");
  }
  return {
    ok: true,
    display: { goal, steps },
    modelContent: JSON.stringify({
      ok: true,
      note: "Plan recorded. Now execute it. You may call make_plan again to revise if findings warrant.",
      stepCount: steps.length,
    }),
  };
}

async function renderReportTool(rawArgs: unknown): Promise<DispatchResult> {
  try {
    const created = await createReport(rawArgs);
    return {
      ok: true,
      display: {
        id: created.id,
        url: created.url,
        title: created.title,
      },
      modelContent: JSON.stringify({
        ok: true,
        id: created.id,
        url: created.url,
        note: "Report rendered. Mention the URL in your final reply so the user can open it.",
      }),
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "render_report failed";
    return {
      ok: false,
      display: { error: message },
      modelContent: JSON.stringify({ ok: false, error: message }),
    };
  }
}

function errorResult(message: string): DispatchResult {
  return {
    ok: false,
    display: { error: message },
    modelContent: JSON.stringify({ error: message }),
  };
}
