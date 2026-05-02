import type { ConnectionConfig, SqlDialect } from "./types";
import { PostgresIntrospector } from "./postgres";

/**
 * Schemas Supabase manages on every project. We hide them from the catalog
 * so the user only sees their own application data — the LLM context stays
 * focused, and we don't try to sample tables we don't have permission for.
 */
export const SUPABASE_INTERNAL_SCHEMAS = [
  "auth",
  "storage",
  "realtime",
  "graphql",
  "graphql_public",
  "extensions",
  "vault",
  "pgsodium",
  "pgsodium_masks",
  "supabase_functions",
  "supabase_migrations",
  "_realtime",
  "_analytics",
  "_supabase",
  "net",
  "pgbouncer",
];

/**
 * Supabase = Postgres with a known set of internal schemas to hide.
 *
 * Connection-wise, you point this at the project's pooler (port 6543) or
 * direct (port 5432) Postgres URL. The Supabase JS client is *not* used here
 * because PostgREST cannot expose the catalog tables (`pg_class`, `pg_index`,
 * etc.) we need for full introspection.
 */
export class SupabaseIntrospector extends PostgresIntrospector {
  override readonly dialect: SqlDialect = "supabase";

  constructor(cfg: ConnectionConfig) {
    super(cfg, { extraHiddenSchemas: SUPABASE_INTERNAL_SCHEMAS });
  }
}

/**
 * Build a `ConnectionConfig` from a Supabase project URL + database password.
 *
 * Supabase project URLs look like `https://<ref>.supabase.co`; the matching
 * database host is `db.<ref>.supabase.co`. Direct connections require SSL.
 */
export function supabaseConnectionFromUrl(args: {
  projectUrl: string;
  password: string;
  database?: string;
  user?: string;
  port?: number;
}): ConnectionConfig {
  const ref = extractProjectRef(args.projectUrl);
  if (!ref) {
    throw new Error(
      `Could not extract project ref from URL: ${args.projectUrl}`,
    );
  }
  return {
    dialect: "supabase",
    host: `db.${ref}.supabase.co`,
    port: args.port ?? 5432,
    database: args.database ?? "postgres",
    user: args.user ?? "postgres",
    password: args.password,
    ssl: { rejectUnauthorized: false },
  };
}

function extractProjectRef(projectUrl: string): string | null {
  try {
    const u = new URL(projectUrl);
    const host = u.hostname;
    const m = host.match(/^([a-z0-9]+)\.supabase\.(co|com|in)$/i);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}
