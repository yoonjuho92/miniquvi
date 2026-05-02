import OpenAI from "openai";

const GLOBAL_KEY = Symbol.for("nl2sql.openaiClient");

/**
 * Process-wide OpenAI client. The SDK keeps an HTTP keep-alive pool, and
 * Next.js dev HMR can leak instances if we recreate it per request.
 */
export function getOpenAI(): OpenAI {
  const g = globalThis as unknown as Record<symbol, OpenAI | undefined>;
  if (!g[GLOBAL_KEY]) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    g[GLOBAL_KEY] = new OpenAI({
      apiKey,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
    });
  }
  return g[GLOBAL_KEY]!;
}

/**
 * Model selection. The picker is a cheap classification task; SQL generation
 * benefits from a stronger model. Both are env-overridable so the user can
 * pin to whatever's current (gpt-5, gpt-4o, gpt-4.1, …).
 */
export function pickerModel(): string {
  return (
    process.env.OPENAI_MODEL_PICKER ||
    process.env.OPENAI_MODEL ||
    "gpt-4o-mini"
  );
}

export function sqlModel(): string {
  return process.env.OPENAI_MODEL_SQL || process.env.OPENAI_MODEL || "gpt-4o";
}

/**
 * Agent loop model. Used by the tool-calling agent — typically the same
 * tier as `sqlModel` since the agent both picks tables and writes SQL,
 * but separate so it can be tuned independently.
 */
export function agentModel(): string {
  return (
    process.env.OPENAI_MODEL_AGENT ||
    process.env.OPENAI_MODEL_SQL ||
    process.env.OPENAI_MODEL ||
    "gpt-4o"
  );
}
