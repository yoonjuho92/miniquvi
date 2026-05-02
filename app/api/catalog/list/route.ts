import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { getRequestConnection } from "@/lib/session";
import { connectionId } from "@/lib/db/pool";
import { loadCatalog, loadTablesIndex } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function catalogRoot(): string {
  return process.env.CATALOG_DIR || path.join(process.cwd(), ".catalog");
}

/**
 * GET /api/catalog/list
 * Returns the manifest plus the rendered tables.md so the client can render
 * the index without parsing the file system itself.
 */
export async function GET(req: NextRequest) {
  const cfg = getRequestConnection(req);
  if (!cfg) {
    return NextResponse.json({ error: "no session" }, { status: 401 });
  }
  const id = connectionId(cfg);
  const handle = await loadCatalog(catalogRoot(), id);
  if (!handle) {
    return NextResponse.json({ ok: false, exists: false });
  }
  const indexMd = (await loadTablesIndex(handle)) ?? "";
  return NextResponse.json({
    ok: true,
    exists: true,
    connectionId: id,
    manifest: handle.manifest,
    tablesIndexMarkdown: indexMd,
  });
}
