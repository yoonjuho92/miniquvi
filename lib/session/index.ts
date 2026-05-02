import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import type { ConnectionConfig, SqlDialect } from "../db/introspect/types";
import { supabaseConnectionFromUrl } from "../db/introspect";
import { SESSION_COOKIE, readSessionCookie } from "./cookies";
import { getSession } from "./store";

export {
  SESSION_COOKIE,
  readSessionCookie,
  writeSessionCookie,
  clearSessionCookie,
} from "./cookies";
export {
  newSessionId,
  putSession,
  getSession,
  deleteSession,
  publicConfigView,
} from "./store";

/** API-route side resolution: session cookie → store. */
export function getRequestConnection(
  req: NextRequest,
): ConnectionConfig | null {
  return getSession(readSessionCookie(req));
}

/** Server Component side resolution: next/headers cookies(). */
export async function getServerConnection(): Promise<ConnectionConfig | null> {
  const c = await cookies();
  return getSession(c.get(SESSION_COOKIE)?.value);
}

/**
 * Build a ConnectionConfig from a connection-form payload. We accept either
 * a connection string OR discrete fields. Supabase URLs are auto-detected.
 */
export interface ConnectionFormInput {
  dialect?: SqlDialect;
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
}

export function configFromForm(input: ConnectionFormInput): ConnectionConfig {
  if (input.connectionString) {
    let url: URL;
    try {
      url = new URL(input.connectionString);
    } catch {
      throw new Error("connectionString is not a valid URL");
    }
    const isSupabase =
      /\.supabase\.(co|com|in)$/i.test(url.hostname) ||
      /supabase\.com$/i.test(url.hostname);
    return {
      dialect: input.dialect ?? (isSupabase ? "supabase" : "postgres"),
      host: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      database: url.pathname.replace(/^\//, "") || "postgres",
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      connectionString: input.connectionString,
      ssl: input.ssl ?? { rejectUnauthorized: false },
    };
  }

  if (
    !input.host ||
    !input.database ||
    !input.user ||
    input.password === undefined
  ) {
    throw new Error(
      "host, database, user, and password are required (or pass a connectionString)",
    );
  }

  return {
    dialect: input.dialect ?? "postgres",
    host: input.host,
    port: input.port ?? 5432,
    database: input.database,
    user: input.user,
    password: input.password,
    ssl: input.ssl ?? { rejectUnauthorized: false },
  };
}

/**
 * Convenience: derive a ConnectionConfig from environment variables, with the
 * same Supabase auto-detection as the CLI scripts. Returns null when no env
 * is configured.
 */
export function configFromEnv(): ConnectionConfig | null {
  if (process.env.DATABASE_URL) {
    return configFromForm({ connectionString: process.env.DATABASE_URL });
  }
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (projectUrl && password) {
    return supabaseConnectionFromUrl({
      projectUrl,
      password,
      port: process.env.SUPABASE_DB_PORT
        ? Number(process.env.SUPABASE_DB_PORT)
        : 5432,
    });
  }
  return null;
}
