import type { ConnectionConfig, DbIntrospector } from "./types";
import { PostgresIntrospector } from "./postgres";
import { SupabaseIntrospector } from "./supabase";

export * from "./types";
export { PostgresIntrospector } from "./postgres";
export { SupabaseIntrospector, supabaseConnectionFromUrl } from "./supabase";

/**
 * Pick the right adapter for a given connection. MySQL/SQL Server land here
 * later; today only Postgres-family dialects are wired up.
 */
export function createIntrospector(cfg: ConnectionConfig): DbIntrospector {
  switch (cfg.dialect) {
    case "postgres":
      return new PostgresIntrospector(cfg);
    case "supabase":
      return new SupabaseIntrospector(cfg);
    case "mysql":
      throw new Error("MySQL adapter not implemented yet (Phase 1: Postgres only)");
    default: {
      const exhaustive: never = cfg.dialect;
      throw new Error(`Unsupported dialect: ${String(exhaustive)}`);
    }
  }
}
