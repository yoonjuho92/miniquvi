import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { getRequestConnection } from "@/lib/session";
import { connectionId } from "@/lib/db/pool";
import { loadCatalog, loadTableMarkdown } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/catalog/table?schema=public&name=orders */
export async function GET(req: NextRequest) {
  const cfg = getRequestConnection(req);
  if (!cfg) {
    return NextResponse.json({ error: "no session" }, { status: 401 });
  }
  const url = new URL(req.url);
  const schema = url.searchParams.get("schema");
  const name = url.searchParams.get("name");
  if (!schema || !name) {
    return NextResponse.json(
      { error: "schema and name query params are required" },
      { status: 400 },
    );
  }

  const id = connectionId(cfg);
  const handle = await loadCatalog(
    process.env.CATALOG_DIR || path.join(process.cwd(), ".catalog"),
    id,
  );
  if (!handle) {
    return NextResponse.json({ error: "catalog not built yet" }, { status: 404 });
  }
  const md = await loadTableMarkdown(handle, schema, name);
  if (!md) {
    return NextResponse.json({ error: "table not found in catalog" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, schema, name, markdown: md });
}
