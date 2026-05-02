import { NextResponse, type NextRequest } from "next/server";
import {
  clearSessionCookie,
  deleteSession,
  readSessionCookie,
} from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const id = readSessionCookie(req);
  deleteSession(id);
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
