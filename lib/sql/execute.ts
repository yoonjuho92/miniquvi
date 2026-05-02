import type { ConnectionConfig } from "../db/introspect/types";
import { getPgPool } from "../db/pool";
import {
  describeGuardError,
  validateReadOnlySql,
  type SqlGuardError,
} from "./guards";

export interface ExecuteOptions {
  /** Per-query statement_timeout in ms. Default 10s. */
  timeoutMs?: number;
  /** Hard cap on rows returned to the client. Default 500. */
  rowCap?: number;
}

export type ExecuteResult =
  | {
      ok: true;
      sql: string;
      columns: { name: string; dataTypeId: number }[];
      rows: Record<string, unknown>[];
      rowCount: number;
      truncated: boolean;
      durationMs: number;
    }
  | {
      ok: false;
      sql: string;
      errors: { kind: "guard"; details: SqlGuardError[] }
        | { kind: "execution"; message: string; pgCode?: string };
    };

/**
 * Execute a single read-only query. Two layers of defense:
 *   1. Static guard (validateReadOnlySql) — rejects anything that isn't a
 *      bare SELECT/WITH/EXPLAIN/VALUES.
 *   2. `SET TRANSACTION READ ONLY` + `statement_timeout` inside a transaction,
 *      so any sneaky DDL/DML that slips past the guard still gets blocked by
 *      Postgres itself.
 *
 * The caller is expected to have set up a read-only DB role separately —
 * this is layer #3 mentioned in the guard module's docstring.
 */
export async function executeReadOnlySql(
  cfg: ConnectionConfig,
  sql: string,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const guard = validateReadOnlySql(sql);
  if (!guard.ok) {
    return {
      ok: false,
      sql,
      errors: { kind: "guard", details: guard.errors },
    };
  }

  const timeoutMs = Math.max(100, opts.timeoutMs ?? 10_000);
  const rowCap = Math.max(1, opts.rowCap ?? 500);

  const pool = getPgPool(cfg);
  const client = await pool.connect();
  const startedAt = Date.now();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    // Defense against runaway scans: ask Postgres to fetch only what we need.
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${timeoutMs * 2}`);

    const result = await client.query(guard.cleaned);
    await client.query("COMMIT");

    const truncated = result.rows.length > rowCap;
    const rows = truncated ? result.rows.slice(0, rowCap) : result.rows;

    return {
      ok: true,
      sql: guard.cleaned,
      columns: result.fields.map((f) => ({
        name: f.name,
        dataTypeId: f.dataTypeID,
      })),
      rows: rows as Record<string, unknown>[],
      rowCount: result.rows.length,
      truncated,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    const e = err as { message?: string; code?: string };
    return {
      ok: false,
      sql: guard.cleaned,
      errors: {
        kind: "execution",
        message: e.message ?? String(err),
        pgCode: e.code,
      },
    };
  } finally {
    client.release();
  }
}

export function formatGuardErrors(errors: SqlGuardError[]): string {
  return errors.map(describeGuardError).join(" ");
}
