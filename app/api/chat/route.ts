import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { getRequestConnection } from "@/lib/session";
import { connectionId } from "@/lib/db/pool";
import { loadCatalog } from "@/lib/catalog";
import { runNl2SqlTurn, type ChatTurn } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  history?: ChatTurn[];
  question?: string;
}

/**
 * POST /api/chat
 * Body: { history, question }
 * Response: NL2SqlResult
 *
 * Stateless: the client owns the history and resends it every turn.
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
  if (!body.question || !body.question.trim()) {
    return NextResponse.json({ error: "question is required" }, { status: 400 });
  }

  const id = connectionId(cfg);
  const handle = await loadCatalog(
    process.env.CATALOG_DIR || path.join(process.cwd(), ".catalog"),
    id,
  );
  if (!handle) {
    return NextResponse.json(
      { error: "catalog not built — run build first" },
      { status: 412 },
    );
  }

  try {
    const result = await runNl2SqlTurn({
      dialect: cfg.dialect,
      catalog: handle,
      history: body.history ?? [],
      question: body.question,
    });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { error: `chat failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}
