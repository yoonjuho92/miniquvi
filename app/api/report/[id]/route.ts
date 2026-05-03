import { type NextRequest } from "next/server";
import { getReportHtml } from "@/lib/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/report/:id — returns the generated HTML report inline. */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const html = await getReportHtml(id);
  if (!html) {
    return new Response("report not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
