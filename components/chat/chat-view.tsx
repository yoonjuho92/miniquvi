"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import type { AgentChatTurn, AgentEvent, AgentTurnState } from "@/lib/llm";
import { AgentMessage } from "./agent-message";

interface Props {
  connection: {
    dialect: string;
    host: string;
    database: string;
    user: string;
  };
  connectionId: string;
}

interface UiTurn {
  role: "user" | "assistant";
  content: string;
  agent?: AgentTurnState;
}

export function ChatView({ connection, connectionId }: Props) {
  const [turns, setTurns] = useState<UiTurn[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns]);

  async function send() {
    const q = input.trim();
    if (!q || pending) return;
    setInput("");
    setError(null);

    const history = turnsToHistory(turns);
    const assistantIndex = turns.length + 1;

    setTurns((prev) => [
      ...prev,
      { role: "user", content: q },
      {
        role: "assistant",
        content: "",
        agent: { status: "running", steps: [], finalText: "" },
      },
    ]);
    setPending(true);

    try {
      const res = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ history, question: q }),
      });
      if (!res.ok || !res.body) {
        const msg = await readError(res);
        setError(msg);
        markFailed(setTurns, assistantIndex, msg);
        return;
      }
      await consumeSse(res.body, (event) => {
        applyEvent(setTurns, assistantIndex, event);
      });
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      markFailed(setTurns, assistantIndex, msg);
    } finally {
      setPending(false);
    }
  }

  function reset() {
    setTurns([]);
    setError(null);
  }

  return (
    <div className="grid h-[calc(100vh-49px)] grid-cols-[260px_1fr]">
      <aside className="border-r border-[var(--border)] p-3 text-xs flex flex-col gap-3">
        <div>
          <div className="text-[var(--muted-foreground)]">Connection</div>
          <div className="font-medium">{connection.dialect}</div>
          <div className="break-all">
            {connection.user}@{connection.host}/{connection.database}
          </div>
          <div className="font-mono text-[10px] text-[var(--muted-foreground)] mt-1">
            {connectionId.slice(0, 12)}…
          </div>
        </div>
        <Link
          href="/catalog"
          className="text-[var(--ring)] underline underline-offset-2"
        >
          Browse catalog →
        </Link>
        <button
          onClick={() => fetch("/api/catalog/ensure", { method: "POST" })}
          className="inline-flex items-center gap-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          <RefreshCw size={12} /> Ensure catalog
        </button>
        <div className="mt-auto">
          <Button variant="ghost" size="sm" onClick={reset}>
            New conversation
          </Button>
        </div>
      </aside>

      <section className="flex min-h-0 flex-col">
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
          {turns.length === 0 ? (
            <Empty />
          ) : (
            <ul className="mx-auto flex max-w-3xl flex-col gap-4">
              {turns.map((t, i) =>
                t.role === "user" ? (
                  <li
                    key={i}
                    className="self-end rounded-2xl bg-[var(--accent)] px-4 py-2 text-sm max-w-[85%]"
                  >
                    {t.content}
                  </li>
                ) : (
                  <li key={i} className="self-start max-w-[95%] w-full">
                    <AgentMessage state={t.agent!} />
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
        <Composer
          input={input}
          setInput={setInput}
          onSend={send}
          pending={pending}
        />
        {error && (
          <p className="px-6 pb-2 text-xs text-[var(--destructive)]">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}

function Empty() {
  return (
    <div className="mx-auto max-w-2xl space-y-3 pt-12 text-center">
      <h2 className="text-lg font-semibold">Ask a question</h2>
      <p className="text-sm text-[var(--muted-foreground)]">
        e.g. <em>“Top 10 best-selling products by quantity”</em>, then refine
        with <em>“그 중 단가가 30 이상인 것만”</em>.
      </p>
      <p className="text-xs text-[var(--muted-foreground)]">
        The agent explores your schema and runs read-only SQL automatically.
      </p>
    </div>
  );
}

function Composer({
  input,
  setInput,
  onSend,
  pending,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  pending: boolean;
}) {
  return (
    <div className="border-t border-[var(--border)] p-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={2}
          placeholder="Ask about your data… (Enter to send, Shift+Enter for newline)"
          disabled={pending}
        />
        <Button onClick={onSend} disabled={pending || !input.trim()}>
          {pending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Send size={14} />
          )}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SSE consumption + state updates
// ---------------------------------------------------------------------------

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const data = parseDataLines(part);
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as AgentEvent);
      } catch {
        // skip malformed event
      }
    }
  }
}

function parseDataLines(chunk: string): string | null {
  const lines = chunk.split("\n");
  const data = lines
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .join("\n");
  return data || null;
}

function applyEvent(
  setTurns: React.Dispatch<React.SetStateAction<UiTurn[]>>,
  index: number,
  event: AgentEvent,
) {
  setTurns((prev) => {
    const turn = prev[index];
    if (!turn || turn.role !== "assistant" || !turn.agent) return prev;
    const next = prev.slice();
    const agent = { ...turn.agent, steps: turn.agent.steps.slice() };
    switch (event.kind) {
      case "step_start":
        agent.steps.push(event);
        break;
      case "tool_call":
        agent.steps.push(event);
        break;
      case "tool_result":
        agent.steps.push(event);
        break;
      case "assistant_text":
        agent.steps.push(event);
        agent.finalText = (agent.finalText
          ? agent.finalText + "\n\n"
          : "") + event.text;
        break;
      case "done":
        agent.status = "done";
        break;
      case "error":
        agent.status = "error";
        agent.errorMessage = event.message;
        break;
    }
    next[index] = {
      ...turn,
      content: agent.finalText,
      agent,
    };
    return next;
  });
}

function markFailed(
  setTurns: React.Dispatch<React.SetStateAction<UiTurn[]>>,
  index: number,
  message: string,
) {
  setTurns((prev) => {
    const turn = prev[index];
    if (!turn || turn.role !== "assistant" || !turn.agent) return prev;
    const next = prev.slice();
    next[index] = {
      ...turn,
      agent: { ...turn.agent, status: "error", errorMessage: message },
    };
    return next;
  });
}

async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    return j.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function turnsToHistory(turns: UiTurn[]): AgentChatTurn[] {
  const out: AgentChatTurn[] = [];
  for (const t of turns) {
    if (t.role === "user") {
      out.push({ role: "user", content: t.content });
    } else if (t.agent?.status === "done" && t.agent.finalText) {
      out.push({ role: "assistant", content: t.agent.finalText });
    }
  }
  return out;
}

export type { UiTurn };
