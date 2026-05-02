import { NextResponse, type NextRequest } from "next/server";
import { getRequestConnection } from "@/lib/session";
import { executeReadOnlySql } from "@/lib/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  sql?: string;
  rowCap?: number;
  timeoutMs?: number;
}

/**
 * POST /api/query/execute
 * Body: { sql, rowCap?, timeoutMs? }
 *
 * Executes inside a READ ONLY transaction with statement_timeout. The static
 * guard rejects DDL/DML before a single byte hits the wire.
 */
export async function POST(req: NextRequest) {
  const cfg = getRequestConnection(req);
  if (!cfg) {
    return NextResponse.json({ error: "no session" }, { status: 401 });
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.sql) {
    return NextResponse.json({ error: "sql is required" }, { status: 400 });
  }
  const result = await executeReadOnlySql(cfg, body.sql, {
    rowCap: body.rowCap,
    timeoutMs: body.timeoutMs,
  });
  return NextResponse.json(result);
}
