import path from "node:path";
import type { NextRequest } from "next/server";
import { loadCatalog } from "@/lib/catalog";
import { connectionId } from "@/lib/db/pool";
import { agentModel, getOpenAI, runAgent, type AgentChatTurn } from "@/lib/llm";
import { getRequestConnection } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  history?: AgentChatTurn[];
  question?: string;
}

/**
 * POST /api/agent/chat — SSE
 *
 * Body: { history, question }
 * Response: text/event-stream of AgentEvent objects, one per `data:` line.
 *
 * The history is just user/assistant text pairs from prior turns — tool
 * traces are scratch work and stay client-side only. The agent can re-issue
 * any tool it needs.
 */
export async function POST(req: NextRequest) {
  const cfg = getRequestConnection(req);
  if (!cfg) {
    return jsonError(401, "no session");
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError(400, "invalid JSON");
  }
  const question = body.question?.trim();
  if (!question) {
    return jsonError(400, "question is required");
  }

  const handle = await loadCatalog(
    process.env.CATALOG_DIR || path.join(process.cwd(), ".catalog"),
    connectionId(cfg),
  );
  if (!handle) {
    return jsonError(412, "catalog not built — run build first");
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      // Initial flush so the client knows the connection is live before the
      // first model round-trip lands (~1-3s).
      controller.enqueue(enc.encode(`: ready\n\n`));
      try {
        for await (const ev of runAgent({
          openai: getOpenAI(),
          model: agentModel(),
          catalog: handle,
          cfg,
          dialect: cfg.dialect,
          history: body.history ?? [],
          question,
        })) {
          send(ev);
        }
      } catch (err) {
        send({ kind: "error", message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}

function jsonError(status: number, error: string) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
