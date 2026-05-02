import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { getRequestConnection } from "@/lib/session";
import { connectionId } from "@/lib/db/pool";
import { loadCatalog, loadRelations } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/catalog/relations — returns the React Flow-shaped relations.json. */
export async function GET(req: NextRequest) {
  const cfg = getRequestConnection(req);
  if (!cfg) {
    return NextResponse.json({ error: "no session" }, { status: 401 });
  }
  const id = connectionId(cfg);
  const handle = await loadCatalog(
    process.env.CATALOG_DIR || path.join(process.cwd(), ".catalog"),
    id,
  );
  if (!handle) {
    return NextResponse.json({ error: "catalog not built yet" }, { status: 404 });
  }
  const graph = (await loadRelations(handle)) ?? { nodes: [], edges: [] };
  return NextResponse.json({ ok: true, graph });
}
