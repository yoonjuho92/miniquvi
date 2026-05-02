/**
 * SQL safety guard for the NL2SQL pipeline.
 *
 * The contract is intentionally narrow: this is the *last* line of defense
 * before we execute LLM-generated SQL. Three layers in production should be:
 *   1. This static check (only SELECT/WITH/EXPLAIN; no second statement; no
 *      forbidden keywords anywhere).
 *   2. A read-only DB role (no DDL/DML privileges).
 *   3. statement_timeout + row cap during execution.
 *
 * If any one of those layers is wrong, the others should still hold.
 */

export type SqlGuardError =
  | { kind: "empty" }
  | { kind: "non-read"; firstKeyword: string }
  | { kind: "forbidden-keyword"; keyword: string }
  | { kind: "multiple-statements" }
  | { kind: "comment-injection" };

export interface SqlGuardResult {
  ok: boolean;
  /** Cleaned-up SQL with trailing comments/whitespace stripped (only when `ok`). */
  cleaned: string;
  errors: SqlGuardError[];
}

/**
 * Top-level statements we allow. WITH must end in SELECT — Postgres also
 * permits `WITH ... INSERT/UPDATE/DELETE`, which we explicitly reject below.
 */
const ALLOWED_FIRST_KEYWORDS = new Set(["SELECT", "WITH", "EXPLAIN", "VALUES"]);

/**
 * Forbidden anywhere in the statement, even inside CTEs or subqueries.
 * `EXECUTE` and `CALL` are blocked because they invoke server-side code that
 * can mutate state under names we can't statically check. `COPY` reads/writes
 * the server filesystem.
 */
const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "COPY",
  "CALL",
  "EXECUTE",
  "DO", // anonymous PL/pgSQL block
  "VACUUM",
  "REINDEX",
  "CLUSTER",
  "REFRESH", // REFRESH MATERIALIZED VIEW
  "LOCK",
  "LISTEN",
  "NOTIFY",
  "SET", // SESSION-level mutation, including search_path
  "RESET",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "PREPARE",
  "DEALLOCATE",
];

const FORBIDDEN_RE = new RegExp(
  String.raw`\b(?:${FORBIDDEN_KEYWORDS.join("|")})\b`,
  "i",
);

export function validateReadOnlySql(sql: string): SqlGuardResult {
  const errors: SqlGuardError[] = [];
  const stripped = stripComments(sql);
  const trimmed = stripped.trim();

  if (!trimmed) {
    return { ok: false, cleaned: "", errors: [{ kind: "empty" }] };
  }

  // Multiple statements — allow exactly one trailing semicolon, nothing after.
  const semis = findUnquotedSemicolons(trimmed);
  if (semis.length > 1) {
    errors.push({ kind: "multiple-statements" });
  } else if (semis.length === 1) {
    const idx = semis[0]!;
    if (trimmed.slice(idx + 1).trim().length > 0) {
      errors.push({ kind: "multiple-statements" });
    }
  }
  const noTrailingSemi = trimmed.replace(/;\s*$/, "");

  // First keyword
  const firstKw = (noTrailingSemi.match(/^\s*([A-Za-z_]+)/) ?? [, ""])[1]!.toUpperCase();
  if (!ALLOWED_FIRST_KEYWORDS.has(firstKw)) {
    errors.push({ kind: "non-read", firstKeyword: firstKw });
  }

  // Forbidden keywords anywhere — uppercase the SQL outside string literals,
  // then keyword-search. We can't perfectly handle dollar-quoted strings,
  // but those are rare in NL2SQL output and the read-only DB role handles
  // any escape that does slip through.
  const masked = maskStringLiterals(noTrailingSemi);
  const forbidden = masked.match(FORBIDDEN_RE);
  if (forbidden) {
    errors.push({
      kind: "forbidden-keyword",
      keyword: forbidden[0].toUpperCase(),
    });
  }

  // Cheap defense against C-style comment injection that survived stripComments
  // (e.g. nested or unterminated). If after stripping we still see /* or --,
  // treat that as suspicious.
  if (/\/\*|--/.test(stripped)) {
    errors.push({ kind: "comment-injection" });
  }

  return {
    ok: errors.length === 0,
    cleaned: noTrailingSemi.trim(),
    errors,
  };
}

export function describeGuardError(e: SqlGuardError): string {
  switch (e.kind) {
    case "empty":
      return "Generated SQL was empty.";
    case "non-read":
      return `Only SELECT/WITH/EXPLAIN/VALUES are allowed; got "${e.firstKeyword}".`;
    case "forbidden-keyword":
      return `Forbidden keyword in SQL: ${e.keyword}.`;
    case "multiple-statements":
      return "Multiple SQL statements are not allowed.";
    case "comment-injection":
      return "Suspicious comment markers remained after sanitization.";
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Strip `--` line comments and `/* ... *​/` block comments. Comments inside
 * string literals are left alone.
 */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    // String literal — copy verbatim until closing quote
    if (c === "'" || c === '"') {
      const end = findClosingQuote(sql, i, c);
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    // Line comment
    if (c === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      if (nl === -1) return out;
      i = nl;
      continue;
    }
    // Block comment
    if (c === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      if (close === -1) return out; // unterminated — drop the rest
      i = close + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function findClosingQuote(sql: string, start: number, quote: string): number {
  for (let i = start + 1; i < sql.length; i++) {
    if (sql[i] === quote) {
      // Doubled quote escape (`''` or `""`) — skip both
      if (sql[i + 1] === quote) {
        i++;
        continue;
      }
      return i;
    }
  }
  return sql.length - 1;
}

function findUnquotedSemicolons(sql: string): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      i = findClosingQuote(sql, i, c) + 1;
      continue;
    }
    if (c === ";") out.push(i);
    i++;
  }
  return out;
}

/** Replace string-literal contents with spaces so keyword-scan can't match them. */
function maskStringLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      const end = findClosingQuote(sql, i, c);
      out += c + " ".repeat(Math.max(0, end - i - 1)) + (sql[end] ?? "");
      i = end + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
