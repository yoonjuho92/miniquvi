import { createHash } from "node:crypto";
import { Pool, type PoolConfig } from "pg";
import type { ConnectionConfig } from "./introspect/types";

/**
 * Process-wide pool registry keyed by a stable connection_id.
 *
 * In Next.js dev, module reloads can leak pools, so we hang the registry off
 * `globalThis` and reuse it across HMR cycles.
 */
const GLOBAL_KEY = Symbol.for("nl2sql.pgPoolRegistry");

type Registry = Map<string, Pool>;

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY]!;
}

/**
 * Stable id derived from (host, port, database, user). Used as the
 * filesystem subdirectory for `.catalog/<id>/` and as the pool key.
 */
export function connectionId(cfg: ConnectionConfig): string {
  const key = `${cfg.dialect}://${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

function toPoolConfig(cfg: ConnectionConfig): PoolConfig {
  if (cfg.connectionString) {
    return {
      connectionString: cfg.connectionString,
      ssl: cfg.ssl ?? { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
    };
  }
  return {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl ?? false,
    max: 5,
    idleTimeoutMillis: 30_000,
  };
}

export function getPgPool(cfg: ConnectionConfig): Pool {
  const reg = registry();
  const id = connectionId(cfg);
  const existing = reg.get(id);
  if (existing) return existing;
  const pool = new Pool(toPoolConfig(cfg));
  reg.set(id, pool);
  return pool;
}

export async function closePgPool(cfg: ConnectionConfig): Promise<void> {
  const reg = registry();
  const id = connectionId(cfg);
  const pool = reg.get(id);
  if (!pool) return;
  reg.delete(id);
  await pool.end();
}

export async function closeAllPgPools(): Promise<void> {
  const reg = registry();
  const pools = Array.from(reg.values());
  reg.clear();
  await Promise.all(pools.map((p) => p.end().catch(() => {})));
}
