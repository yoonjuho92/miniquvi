import { z } from "zod";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { zodResponseFormat } from "openai/helpers/zod";
import type {
  CatalogHandle,
  RelationGraph,
} from "../catalog";
import {
  loadRelations,
  loadTableMarkdowns,
  loadTableSummaries,
  loadTablesIndex,
} from "../catalog";
import type { SqlDialect } from "../db/introspect/types";
import { getOpenAI, pickerModel, sqlModel } from "./openai";

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

export interface NL2SqlEngineOptions {
  /** Max tables to send into the SQL-gen prompt. Default 8. */
  maxTables?: number;
  /** When true, also stream picker-stage logs via onProgress. Default true. */
  verbose?: boolean;
  /** Default LIMIT to suggest in the prompt for list-style questions. Default 100. */
  defaultLimit?: number;
}

export interface ChatTurn {
  role: "user" | "assistant";
  /** User question (role === "user") or assistant explanation (role === "assistant"). */
  content: string;
  /** SQL the assistant produced this turn (only on assistant turns). */
  sql?: string;
  /** Compact summary of execution result, fed back into context (only on assistant turns). */
  resultSummary?: string;
}

export interface PickedTable {
  schema: string;
  name: string;
  reason: string;
}

export type NL2SqlMode = "sql" | "answer";

export interface NL2SqlResult {
  /** "sql" = SQL was generated and is ready to run. "answer" = the question was
   *  answerable purely from the catalog metadata; `sql` is empty and `notes`
   *  carries the full answer. */
  mode: NL2SqlMode;
  pickedTables: PickedTable[];
  sql: string;
  /** SQL mode: 1–2 sentences explaining the query. Answer mode: the full reply. */
  notes: string;
  /** Soft warnings the LLM raised (e.g. "data may be incomplete"). */
  warnings: string[];
  /** What we actually sent into each model — useful for debugging. */
  debug: {
    pickerModel: string;
    sqlModel: string;
    pickerPromptChars: number;
    sqlPromptChars: number;
  };
}

export type ProgressEvent =
  | { kind: "picker-start" }
  | { kind: "picker-done"; picked: PickedTable[] }
  | { kind: "sql-start" }
  | { kind: "sql-done"; sql: string };

// ---------------------------------------------------------------------------
// schemas (structured outputs)
// ---------------------------------------------------------------------------

const PickerSchema = z.object({
  tables: z.array(
    z.object({
      schema: z.string(),
      name: z.string(),
      reason: z.string(),
    }),
  ),
});

const SqlSchema = z.object({
  mode: z.enum(["sql", "answer"]),
  sql: z.string(),
  notes: z.string(),
  warnings: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// engine
// ---------------------------------------------------------------------------

export interface RunTurnArgs {
  dialect: SqlDialect;
  catalog: CatalogHandle;
  history: ChatTurn[];
  question: string;
  options?: NL2SqlEngineOptions;
  onProgress?: (e: ProgressEvent) => void;
}

/**
 * Generate one assistant turn: pick relevant tables → generate SQL.
 * Does NOT execute the SQL — the caller decides whether/when to run it.
 */
export async function runNl2SqlTurn(args: RunTurnArgs): Promise<NL2SqlResult> {
  const opts = args.options ?? {};
  const maxTables = opts.maxTables ?? 8;
  const defaultLimit = opts.defaultLimit ?? 100;
  const emit = args.onProgress ?? (() => {});

  // ---- Step 1: pick relevant tables --------------------------------------
  emit({ kind: "picker-start" });
  const summaries = await loadTableSummaries(args.catalog);
  const indexMd = (await loadTablesIndex(args.catalog)) ?? "";

  // We give the picker the index md (compact) plus the history's SQL/results
  // so refinement turns ("그 중 액션 장르만") can latch onto the prior tables.
  const pickerSystem = renderPickerSystem(args.dialect);
  const pickerUser = renderPickerUser({
    indexMd,
    history: args.history,
    question: args.question,
    knownTables: summaries.map((s) => `${s.schema}.${s.name}`),
    maxTables,
  });

  const pickerCompletion = await getOpenAI().chat.completions.create({
    model: pickerModel(),
    messages: [
      { role: "system", content: pickerSystem },
      { role: "user", content: pickerUser },
    ],
    response_format: zodResponseFormat(PickerSchema, "table_selection"),
    temperature: 0,
  });

  const picked = parsePicker(pickerCompletion).tables.slice(0, maxTables);
  // Filter against the catalog so the LLM can't invent tables.
  const knownSet = new Set(summaries.map((s) => `${s.schema}.${s.name}`));
  const filtered = picked.filter((p) => knownSet.has(`${p.schema}.${p.name}`));
  emit({ kind: "picker-done", picked: filtered });

  // ---- Step 2: load detailed mds + relevant FKs --------------------------
  const tableMds = await loadTableMarkdowns(
    args.catalog,
    filtered.map((p) => ({ schema: p.schema, name: p.name })),
  );
  const relations = await loadRelations(args.catalog);
  const relationsSummary = relations
    ? renderRelationsSummary(relations, filtered)
    : "";

  // ---- Step 3: generate SQL ---------------------------------------------
  emit({ kind: "sql-start" });
  const sqlSystem = renderSqlSystem({
    dialect: args.dialect,
    defaultLimit,
  });
  const sqlUser = renderSqlUser({
    catalogIndexMd: indexMd,
    tableMds,
    relationsSummary,
    history: args.history,
    question: args.question,
  });

  const sqlCompletion = await getOpenAI().chat.completions.create({
    model: sqlModel(),
    messages: [
      { role: "system", content: sqlSystem },
      { role: "user", content: sqlUser },
    ],
    response_format: zodResponseFormat(SqlSchema, "sql_response"),
    temperature: 0,
  });

  const parsed = parseSql(sqlCompletion);
  // Trust the model's mode label, but defensively coerce: if the model said
  // "answer" but produced SQL, or said "sql" but produced none, fall back to
  // whichever side actually has content.
  let mode: NL2SqlMode = parsed.mode;
  const trimmedSql = parsed.sql.trim();
  if (mode === "sql" && !trimmedSql) mode = "answer";
  if (mode === "answer" && trimmedSql) mode = "sql";
  emit({ kind: "sql-done", sql: mode === "sql" ? trimmedSql : "" });

  return {
    mode,
    pickedTables: filtered,
    sql: mode === "sql" ? trimmedSql : "",
    notes: parsed.notes,
    warnings: parsed.warnings,
    debug: {
      pickerModel: pickerModel(),
      sqlModel: sqlModel(),
      pickerPromptChars: pickerSystem.length + pickerUser.length,
      sqlPromptChars: sqlSystem.length + sqlUser.length,
    },
  };
}

// ---------------------------------------------------------------------------
// prompt templates
// ---------------------------------------------------------------------------

function renderPickerSystem(dialect: SqlDialect): string {
  return [
    "You are a database expert helping pick the smallest set of tables a SQL writer will need to answer the user's question.",
    `The target SQL dialect is ${dialect}.`,
    "Rules:",
    "1. Pick only tables that exist in the provided catalog index.",
    "2. Prefer including foreign-key chain partners (e.g., picking `orders` usually means also picking `customers` if the question mentions customer attributes).",
    "3. If the user is refining a previous turn, reuse the prior turn's tables unless the new question clearly needs new ones.",
    "4. For each picked table, give a one-sentence reason in plain language.",
    "5. Output ONLY the structured JSON object — no extra prose.",
  ].join("\n");
}

interface PickerUserArgs {
  indexMd: string;
  history: ChatTurn[];
  question: string;
  knownTables: string[];
  maxTables: number;
}

function renderPickerUser(args: PickerUserArgs): string {
  const histBlock = args.history.length
    ? `\n\n## Conversation so far\n${renderHistoryForPrompt(args.history)}`
    : "";
  return [
    `## Catalog index (table summaries)`,
    "",
    args.indexMd || "(empty)",
    "",
    `## Known tables (whitelist; pick only from these)`,
    "",
    args.knownTables.map((t) => `- ${t}`).join("\n"),
    histBlock,
    "",
    `## Current user question`,
    "",
    args.question,
    "",
    `Pick at most ${args.maxTables} tables.`,
  ].join("\n");
}

function renderSqlSystem(args: {
  dialect: SqlDialect;
  defaultLimit: number;
}): string {
  const dialectNote =
    args.dialect === "postgres" || args.dialect === "supabase"
      ? "Use PostgreSQL syntax. Schema-qualify all table references (e.g. `public.orders`). Use double-quoted identifiers only when needed."
      : args.dialect === "mysql"
        ? "Use MySQL 8 syntax. Backtick-quote identifiers when needed."
        : "";
  return [
    "You answer the user's question about a database. Choose ONE of two modes:",
    "",
    "Mode `answer` — when the question is about the schema/catalog itself and is fully answerable from the provided metadata. Examples:",
    '  - "What columns does the orders table have?"',
    '  - "How many tables are there?" / "Which tables exist?"',
    '  - "How are orders and customers related?" / "What is the FK between them?"',
    '  - "What is the primary key of products?"',
    '  - "Which table stores categories?" / "What does X mean?"',
    "  Set `mode: \"answer\"`, leave `sql` empty (\"\"), and put the full reply in `notes`. Use markdown lists when listing columns/tables.",
    "",
    "Mode `sql` — when answering requires querying the actual data. Examples:",
    '  - "How many customers?" / "Top 10 best-selling products"',
    '  - "Show all orders from 1997" / "Average freight per country"',
    "  Set `mode: \"sql\"`, write the SQL in `sql`, and a 1–2 sentence summary in `notes`.",
    "",
    "If you are not sure, prefer `sql` and let the user run it.",
    "",
    dialectNote,
    "",
    "Hard rules for `sql` mode — violations cause the system to reject your output:",
    "1. Only SELECT or WITH ... SELECT. Never produce DDL or DML (no INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE/GRANT/REVOKE/CALL/COPY/SET).",
    "2. Output a single statement. No semicolon-separated chains.",
    "3. Use only the tables and columns shown in the schema reference below — do not invent columns.",
    `4. If the question implies a list and no explicit limit is given, append \`LIMIT ${args.defaultLimit}\`. If the question implies an aggregate (count/sum/avg) you can omit the limit.`,
    "5. Use the foreign-key information to write JOINs.",
    "",
    "Style:",
    "- Prefer explicit JOINs over implicit comma joins.",
    "- For Korean questions, write `notes` in Korean; otherwise mirror the user's language.",
    "",
    "If the question is ambiguous or under-specified, still produce your best-effort SQL and put your assumptions in `warnings`.",
  ].join("\n");
}

interface SqlUserArgs {
  catalogIndexMd: string;
  tableMds: { schema: string; name: string; markdown: string }[];
  relationsSummary: string;
  history: ChatTurn[];
  question: string;
}

function renderSqlUser(args: SqlUserArgs): string {
  const histBlock = args.history.length
    ? `\n\n## Conversation so far\n${renderHistoryForPrompt(args.history)}`
    : "";
  const tablesBlock = args.tableMds.length
    ? args.tableMds
        .map((t) => `### ${t.schema}.${t.name}\n\n${t.markdown}`)
        .join("\n\n---\n\n")
    : "_(no specific tables loaded; answer from the catalog overview above, or ask for clarification in `notes`)_";
  return [
    "## Catalog overview (every table in the database)",
    "",
    args.catalogIndexMd || "(empty)",
    "",
    "## Schema reference (detailed metadata for the relevant tables)",
    "",
    tablesBlock,
    args.relationsSummary
      ? `\n## Foreign-key relations\n\n${args.relationsSummary}`
      : "",
    histBlock,
    "",
    "## Current user question",
    "",
    args.question,
  ].join("\n");
}

function renderRelationsSummary(
  graph: RelationGraph,
  picked: PickedTable[],
): string {
  const pickedSet = new Set(picked.map((p) => `${p.schema}.${p.name}`));
  const relevant = graph.edges.filter(
    (e) => pickedSet.has(e.from) || pickedSet.has(e.to),
  );
  if (!relevant.length) return "";
  return relevant
    .map(
      (e) =>
        `- \`${e.from}\`(${e.fromColumns.join(",")}) → \`${e.to}\`(${e.toColumns.join(",")})`,
    )
    .join("\n");
}

/**
 * Compact rendering of multi-turn history for prompts. Result rows are
 * truncated to keep token cost bounded — just the first few rows.
 */
function renderHistoryForPrompt(history: ChatTurn[]): string {
  const lines: string[] = [];
  for (const turn of history) {
    if (turn.role === "user") {
      lines.push(`USER: ${turn.content}`);
    } else {
      lines.push(`ASSISTANT: ${turn.content}`);
      if (turn.sql) {
        lines.push("```sql");
        lines.push(turn.sql);
        lines.push("```");
      }
      if (turn.resultSummary) {
        lines.push(`RESULT: ${turn.resultSummary}`);
      }
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// completion parsing
// ---------------------------------------------------------------------------

function parsePicker(c: ChatCompletion): z.infer<typeof PickerSchema> {
  const raw = c.choices[0]?.message?.content;
  if (!raw) return { tables: [] };
  try {
    return PickerSchema.parse(JSON.parse(raw));
  } catch {
    return { tables: [] };
  }
}

function parseSql(c: ChatCompletion): z.infer<typeof SqlSchema> {
  const raw = c.choices[0]?.message?.content;
  if (!raw) {
    throw new Error("SQL generator returned empty content");
  }
  return SqlSchema.parse(JSON.parse(raw));
}

// ---------------------------------------------------------------------------
// helper: build a result summary suitable for the next turn's history
// ---------------------------------------------------------------------------

export function summarizeRowsForHistory(
  rows: Record<string, unknown>[],
  rowCount: number,
  truncated: boolean,
): string {
  if (rows.length === 0) return `${rowCount} rows (no data).`;
  const sample = rows.slice(0, 3);
  const cols = Object.keys(sample[0] ?? {});
  const preview = sample
    .map(
      (r) =>
        "{ " +
        cols
          .slice(0, 6)
          .map((c) => `${c}: ${shortValue(r[c])}`)
          .join(", ") +
        (cols.length > 6 ? ", …" : "") +
        " }",
    )
    .join(", ");
  return `${rowCount}${truncated ? "+" : ""} rows; first: ${preview}`;
}

function shortValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v.length > 40 ? v.slice(0, 37) + "…" : v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    try {
      const j = JSON.stringify(v);
      return j.length > 40 ? j.slice(0, 37) + "…" : j;
    } catch {
      return String(v);
    }
  }
  return String(v);
}
