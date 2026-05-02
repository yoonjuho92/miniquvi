import { NextResponse, type NextRequest } from "next/server";
import { getRequestConnection } from "@/lib/session";
import { createIntrospector } from "@/lib/db/introspect";
import { buildCatalog } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Forced full rebuild. Used by the `/connect` page after a fresh session. */
export async function POST(req: NextRequest) {
  const cfg = getRequestConnection(req);
  if (!cfg) {
    return NextResponse.json({ error: "no session" }, { status: 401 });
  }
  try {
    const introspector = createIntrospector(cfg);
    const result = await buildCatalog(cfg, introspector);
    return NextResponse.json({
      ok: true,
      rebuilt: result.rebuilt.length,
      reused: result.reused.length,
      manifest: result.manifest,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `catalog build failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
