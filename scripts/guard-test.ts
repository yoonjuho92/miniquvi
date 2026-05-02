/**
 * Phase 4 SQL guard regression check. Run:
 *   pnpm tsx scripts/guard-test.ts
 *
 * Each case asserts that validateReadOnlySql either accepts or rejects the
 * statement. No DB connection required.
 */
import { validateReadOnlySql, describeGuardError } from "../lib/sql/guards";

interface Case {
  sql: string;
  expectOk: boolean;
  label: string;
}

const cases: Case[] = [
  { label: "plain SELECT", sql: "SELECT 1", expectOk: true },
  { label: "SELECT with trailing semi", sql: "SELECT 1;", expectOk: true },
  {
    label: "WITH ... SELECT (CTE)",
    sql: "WITH t AS (SELECT 1 AS x) SELECT x FROM t",
    expectOk: true,
  },
  {
    label: "EXPLAIN SELECT",
    sql: "EXPLAIN SELECT * FROM public.orders",
    expectOk: true,
  },
  { label: "DROP TABLE", sql: "DROP TABLE public.orders", expectOk: false },
  { label: "INSERT", sql: "INSERT INTO public.orders DEFAULT VALUES", expectOk: false },
  { label: "UPDATE", sql: "UPDATE public.orders SET freight = 0", expectOk: false },
  { label: "DELETE", sql: "DELETE FROM public.orders", expectOk: false },
  { label: "TRUNCATE", sql: "TRUNCATE public.orders", expectOk: false },
  {
    label: "WITH RECURSIVE that ends in DELETE",
    sql: "WITH t AS (SELECT 1) DELETE FROM public.orders",
    expectOk: false,
  },
  {
    label: "two statements",
    sql: "SELECT 1; SELECT 2",
    expectOk: false,
  },
  {
    label: "SELECT then DROP",
    sql: "SELECT 1; DROP TABLE public.orders",
    expectOk: false,
  },
  {
    label: "comment-injection bypass attempt",
    sql: "SELECT 1 /* ; DROP TABLE x; */",
    expectOk: true, // comments are stripped — semicolon inside comment doesn't count
  },
  {
    label: "drop hidden in line comment then real drop",
    sql: "SELECT 1 -- ok\n; DROP TABLE x",
    expectOk: false,
  },
  {
    label: "string literal containing DROP keyword",
    sql: "SELECT 'DROP TABLE x' AS msg",
    expectOk: true,
  },
  {
    label: "SET search_path injection",
    sql: "SET search_path = public",
    expectOk: false,
  },
  { label: "empty", sql: "   ", expectOk: false },
];

let passed = 0;
let failed = 0;
for (const c of cases) {
  const r = validateReadOnlySql(c.sql);
  const ok = r.ok === c.expectOk;
  if (ok) {
    passed++;
    console.log(`PASS  ${c.label}`);
  } else {
    failed++;
    console.log(
      `FAIL  ${c.label} — expected ok=${c.expectOk}, got ok=${r.ok} (${r.errors.map(describeGuardError).join("; ")})`,
    );
  }
}
console.log(`\n${passed}/${passed + failed} passed`);
process.exitCode = failed > 0 ? 1 : 0;
