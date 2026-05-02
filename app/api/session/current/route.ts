import { NextResponse, type NextRequest } from "next/server";
import { getRequestConnection, publicConfigView } from "@/lib/session";
import { connectionId } from "@/lib/db/pool";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const cfg = getRequestConnection(req);
  if (!cfg) {
    return NextResponse.json({ ok: false }, { status: 200 });
  }
  return NextResponse.json({
    ok: true,
    connectionId: connectionId(cfg),
    connection: publicConfigView(cfg),
  });
}
