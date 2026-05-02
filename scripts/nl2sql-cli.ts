/**
 * Phase 4 NL2SQL multi-turn CLI tester.
 *
 *   pnpm nl2sql                              # interactive REPL
 *   pnpm nl2sql -- "지난달 매출 상위 10개 영화는?" "그 중 액션 장르만"
 *
 * - Loads the catalog for the configured connection (must `pnpm catalog:build` first).
 * - For each user turn: pick tables → generate SQL → validate → execute → print.
 * - History is kept in-memory across turns so refinement queries work.
 */
import "dotenv/config";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { closeAllPgPools, connectionId } from "../lib/db/pool";
import {
  createIntrospector,
  supabaseConnectionFromUrl,
  type ConnectionConfig,
} from "../lib/db/introspect";
import { loadCatalog } from "../lib/catalog";
import {
  runNl2SqlTurn,
  summarizeRowsForHistory,
  type ChatTurn,
} from "../lib/llm";
import { executeReadOnlySql, formatGuardErrors } from "../lib/sql";

function configFromEnv(): ConnectionConfig {
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    const isSupabase =
      /\.supabase\.(co|com|in)$/i.test(url.hostname) ||
      /supabase\.com$/i.test(url.hostname);
    return {
      dialect: isSupabase ? "supabase" : "postgres",
      host: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      database: url.pathname.replace(/^\//, "") || "postgres",
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    };
  }
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (projectUrl && password) {
    return supabaseConnectionFromUrl({
      projectUrl,
      password,
      port: process.env.SUPABASE_DB_PORT
        ? Number(process.env.SUPABASE_DB_PORT)
        : 5432,
    });
  }
  throw new Error(
    "Set DATABASE_URL, or NEXT_PUBLIC_SUPABASE_URL + SUPABASE_DB_PASSWORD, in .env.local",
  );
}

async function processTurn(args: {
  cfg: ConnectionConfig;
  catalogRoot: string;
  history: ChatTurn[];
  question: string;
  autoExecute: boolean;
}): Promise<ChatTurn[]> {
  const { cfg, catalogRoot, history, question, autoExecute } = args;
  const id = connectionId(cfg);
  const handle = await loadCatalog(catalogRoot, id);
  if (!handle) {
    throw new Error(
      `No catalog at ${catalogRoot}/${id}. Run \`pnpm catalog:build\` first.`,
    );
  }

  const result = await runNl2SqlTurn({
    dialect: cfg.dialect,
    catalog: handle,
    history,
    question,
    onProgress: (e) => {
      if (e.kind === "picker-done") {
        const list = e.picked
          .map((p) => `${p.schema}.${p.name}`)
          .join(", ");
        console.log(`  picked: ${list || "(none)"}`);
      }
    },
  });

  console.log("\n--- generated SQL ---");
  console.log(result.sql);
  console.log("---------------------");
  if (result.notes) console.log(`notes: ${result.notes}`);
  if (result.warnings.length) {
    console.log(`warnings: ${result.warnings.join(" / ")}`);
  }

  let resultSummary = "(not executed)";
  if (autoExecute) {
    const exec = await executeReadOnlySql(cfg, result.sql, {
      timeoutMs: 10_000,
      rowCap: 50,
    });
    if (!exec.ok) {
      if (exec.errors.kind === "guard") {
        const msg = formatGuardErrors(exec.errors.details);
        console.log(`\n[guard rejected] ${msg}`);
        resultSummary = `guard rejected: ${msg}`;
      } else {
        console.log(`\n[execution error] ${exec.errors.message}`);
        resultSummary = `execution error: ${exec.errors.message}`;
      }
    } else {
      console.log(
        `\nrows: ${exec.rowCount}${exec.truncated ? "+" : ""} (${exec.durationMs}ms)`,
      );
      const preview = exec.rows.slice(0, 5);
      for (const row of preview) console.log(`  ${JSON.stringify(row)}`);
      if (exec.rows.length > preview.length) {
        console.log(`  … (${exec.rows.length - preview.length} more)`);
      }
      resultSummary = summarizeRowsForHistory(
        exec.rows,
        exec.rowCount,
        exec.truncated,
      );
    }
  }

  return [
    ...history,
    { role: "user", content: question },
    {
      role: "assistant",
      content: result.notes,
      sql: result.sql,
      resultSummary,
    },
  ];
}

interface CliArgs {
  questions: string[];
  noExecute: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { questions: [], noExecute: false };
  for (const a of argv) {
    if (a === "--no-execute") out.noExecute = true;
    else if (a !== "--") out.questions.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = configFromEnv();
  // Ensure pool is alive (some calls in execute use it)
  createIntrospector(cfg);
  const catalogRoot = process.env.CATALOG_DIR || `${process.cwd()}/.catalog`;

  let history: ChatTurn[] = [];

  if (args.questions.length > 0) {
    for (const q of args.questions) {
      console.log(`\n>>> ${q}`);
      history = await processTurn({
        cfg,
        catalogRoot,
        history,
        question: q,
        autoExecute: !args.noExecute,
      });
    }
    return;
  }

  // Interactive REPL.
  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log("nl2sql REPL — empty line to exit, /reset to clear history.");
  while (true) {
    const q = (await rl.question("\n> ")).trim();
    if (!q) break;
    if (q === "/reset") {
      history = [];
      console.log("(history cleared)");
      continue;
    }
    try {
      history = await processTurn({
        cfg,
        catalogRoot,
        history,
        question: q,
        autoExecute: !args.noExecute,
      });
    } catch (err) {
      console.error("turn failed:", (err as Error).message);
    }
  }
  rl.close();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAllPgPools();
  });
