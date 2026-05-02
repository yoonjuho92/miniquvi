import { NextResponse, type NextRequest } from "next/server";
import { getRequestConnection } from "@/lib/session";
import { createIntrospector } from "@/lib/db/introspect";
import { ensureCatalog } from "@/lib/catalog";

export const runtime = "nodejs";
// Catalog builds can take 30s+; opt out of any default static caching.
export const dynamic = "force-dynamic";

interface Body {
  force?: boolean;
}

export async function POST(req: NextRequest) {
  const cfg = getRequestConnection(req);
  if (!cfg) {
    return NextResponse.json({ error: "no session" }, { status: 401 });
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // empty body is fine
  }

  try {
    const introspector = createIntrospector(cfg);
    const result = await ensureCatalog(cfg, introspector, {
      force: !!body.force,
    });
    return NextResponse.json({
      ok: true,
      noChanges: result.noChanges,
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
