import { NextResponse, type NextRequest } from "next/server";
import { getRequestConnection } from "@/lib/session";
import { createIntrospector } from "@/lib/db/introspect";
import { refreshTable } from "@/lib/catalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  schema?: string;
  name?: string;
}

/** POST /api/catalog/refresh — body { schema, name } refreshes one table. */
export async function POST(req: NextRequest) {
  const cfg = getRequestConnection(req);
  if (!cfg) {
    return NextResponse.json({ error: "no session" }, { status: 401 });
  }
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // empty body
  }
  if (!body.schema || !body.name) {
    return NextResponse.json(
      { error: "schema and name are required" },
      { status: 400 },
    );
  }
  try {
    const introspector = createIntrospector(cfg);
    const profile = await refreshTable(cfg, introspector, body.schema, body.name);
    if (!profile) {
      return NextResponse.json({
        ok: true,
        dropped: true,
        schema: body.schema,
        name: body.name,
      });
    }
    return NextResponse.json({
      ok: true,
      dropped: false,
      schema: profile.schema,
      name: profile.name,
      sampledSkipped: profile.sampledSkipped,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `refresh failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
