import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { CatalogHandle } from "../../catalog";
import type { ConnectionConfig, SqlDialect } from "../../db/introspect/types";
import { renderAgentSystem } from "./system";
import { dispatchTool, makeAgentTools } from "./tools";
import type { AgentChatTurn, AgentEvent } from "./types";

/** Hard ceiling on agent iterations (one LLM call per step). */
const MAX_STEPS = 12;
/** Hard ceiling on `run_sql` calls per turn. The system prompt asks the model
 *  to stay under 6; this is the safety net if it ignores that. */
const MAX_RUN_SQL = 8;

export interface RunAgentArgs {
  openai: OpenAI;
  model: string;
  catalog: CatalogHandle;
  cfg: ConnectionConfig;
  dialect: SqlDialect;
  history: AgentChatTurn[];
  question: string;
}

/**
 * Drive the agent loop. Yields AgentEvents in real time so the route can
 * stream them to the UI as SSE.
 */
export async function* runAgent(args: RunAgentArgs): AsyncGenerator<AgentEvent> {
  const tools = makeAgentTools();
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: renderAgentSystem(args.dialect) },
    ...args.history.map(
      (h): ChatCompletionMessageParam => ({ role: h.role, content: h.content }),
    ),
    { role: "user", content: args.question },
  ];
  let runSqlCount = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    yield { kind: "step_start", step };

    const completion = await args.openai.chat.completions.create({
      model: args.model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0,
    });
    const choice = completion.choices[0];
    if (!choice) {
      yield { kind: "error", message: "model returned no choices" };
      return;
    }

    const msg = choice.message;
    // Echo the assistant turn back into the conversation verbatim so the
    // model sees its own tool_calls when it runs again.
    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    } as ChatCompletionMessageParam);

    if (msg.content) {
      yield { kind: "assistant_text", text: msg.content };
    }

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      yield { kind: "done", finishReason: choice.finish_reason ?? "stop" };
      return;
    }

    for (const tc of toolCalls) {
      if (tc.type !== "function") continue;
      const name = tc.function.name;
      const parsedArgs = parseArgs(tc.function.arguments);
      yield { kind: "tool_call", call: { id: tc.id, name, args: parsedArgs } };

      // Per-turn rate-limit on run_sql.
      if (name === "run_sql") {
        runSqlCount++;
        if (runSqlCount > MAX_RUN_SQL) {
          const message = `refused: exceeded run_sql limit (${MAX_RUN_SQL} per turn)`;
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ ok: false, error: message }),
          });
          yield {
            kind: "tool_result",
            result: { id: tc.id, name, ok: false, display: { error: message } },
          };
          continue;
        }
      }

      const out = await dispatchTool(name, parsedArgs, {
        catalog: args.catalog,
        cfg: args.cfg,
      });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: out.modelContent,
      });
      yield {
        kind: "tool_result",
        result: { id: tc.id, name, ok: out.ok, display: out.display },
      };
    }
  }

  yield {
    kind: "error",
    message: `agent did not converge within ${MAX_STEPS} steps`,
  };
}

function parseArgs(raw: string | null | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparsed: raw };
  }
}
