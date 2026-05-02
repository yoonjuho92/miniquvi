import { NextResponse, type NextRequest } from "next/server";
import {
  configFromEnv,
  configFromForm,
  newSessionId,
  publicConfigView,
  putSession,
  writeSessionCookie,
  type ConnectionFormInput,
} from "@/lib/session";
import { connectionId } from "@/lib/db/pool";
import { createIntrospector } from "@/lib/db/introspect";

export const runtime = "nodejs";

interface ConnectBody extends ConnectionFormInput {
  /** When true, the server reads its own env vars — the password never crosses the wire. */
  useEnv?: boolean;
}

/**
 * POST /api/session/connect
 * Body: ConnectBody — either { useEnv: true } OR a ConnectionFormInput
 *  - Validates by calling listSchemas() once
 *  - On success, stores the config server-side and sets an httpOnly session cookie
 */
export async function POST(req: NextRequest) {
  let body: ConnectBody;
  try {
    body = (await req.json()) as ConnectBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  let config;
  try {
    if (body.useEnv) {
      const env = configFromEnv();
      if (!env) {
        return NextResponse.json(
          { error: "no env config available (set DATABASE_URL or SUPABASE_DB_PASSWORD)" },
          { status: 400 },
        );
      }
      config = env;
    } else {
      config = configFromForm(body);
    }
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }

  // Smoke-test the connection. We cap the work to listSchemas() so this
  // round-trip stays sub-second. The pool stays alive on success.
  try {
    const introspector = createIntrospector(config);
    await introspector.listSchemas();
  } catch (err) {
    return NextResponse.json(
      { error: `Connection failed: ${(err as Error).message}` },
      { status: 400 },
    );
  }

  const sessionId = newSessionId();
  putSession(sessionId, config);

  const res = NextResponse.json({
    ok: true,
    sessionId,
    connectionId: connectionId(config),
    connection: publicConfigView(config),
  });
  writeSessionCookie(res, sessionId);
  return res;
}
