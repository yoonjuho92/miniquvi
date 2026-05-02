/**
 * Public types for the tool-using agent. Kept separate from the loop so the
 * UI and the SSE route can import these without dragging in the OpenAI SDK.
 */

export interface ToolCallRecord {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResultRecord {
  id: string;
  name: string;
  ok: boolean;
  /** Compact, UI-renderable payload. Full schema depends on `name`. */
  display: unknown;
}

export type AgentEvent =
  | { kind: "step_start"; step: number }
  | { kind: "tool_call"; call: ToolCallRecord }
  | { kind: "tool_result"; result: ToolResultRecord }
  | { kind: "assistant_text"; text: string }
  | { kind: "done"; finishReason: string }
  | { kind: "error"; message: string };

/**
 * One past turn that gets fed back into the next agent invocation. We only
 * persist the user question and the assistant's final natural-language reply
 * — tool calls are scratch work and the model can re-issue them if needed.
 */
export interface AgentChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** UI-side per-turn state. */
export interface AgentTurnState {
  status: "running" | "done" | "error";
  steps: AgentEvent[];
  /** Concatenated assistant text segments (final answer). */
  finalText: string;
  errorMessage?: string;
}
