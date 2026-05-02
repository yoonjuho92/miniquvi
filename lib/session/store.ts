import { randomBytes } from "node:crypto";
import type { ConnectionConfig } from "../db/introspect/types";

const GLOBAL_KEY = Symbol.for("nl2sql.sessionStore");

interface SessionRecord {
  config: ConnectionConfig;
  createdAt: number;
  lastUsedAt: number;
}

type Store = Map<string, SessionRecord>;

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY]!;
}

export function newSessionId(): string {
  return randomBytes(16).toString("hex");
}

export function putSession(id: string, config: ConnectionConfig): void {
  const now = Date.now();
  store().set(id, { config, createdAt: now, lastUsedAt: now });
}

export function getSession(id: string | undefined): ConnectionConfig | null {
  if (!id) return null;
  const rec = store().get(id);
  if (!rec) return null;
  rec.lastUsedAt = Date.now();
  return rec.config;
}

export function deleteSession(id: string | undefined): void {
  if (!id) return;
  store().delete(id);
}

/** Strip secrets before returning to the client. */
export function publicConfigView(cfg: ConnectionConfig): {
  dialect: ConnectionConfig["dialect"];
  host: string;
  port: number;
  database: string;
  user: string;
} {
  return {
    dialect: cfg.dialect,
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
  };
}
