"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  ListTree,
  Loader2,
  Network,
  Table2,
  Wrench,
} from "lucide-react";
import { Card, CardBody } from "@/components/ui/card";
import type {
  AgentEvent,
  AgentTurnState,
  ToolCallRecord,
  ToolResultRecord,
} from "@/lib/llm";

export function AgentMessage({ state }: { state: AgentTurnState }) {
  const pairs = pairToolEvents(state.steps);
  const isRunning = state.status === "running";
  const showThinking = isRunning && pairs.length === 0 && !state.finalText;

  return (
    <Card>
      <CardBody className="space-y-3">
        {pairs.length > 0 && (
          <ol className="space-y-2">
            {pairs.map((p, i) => (
              <li key={i}>
                <ToolStep pair={p} />
              </li>
            ))}
          </ol>
        )}

        {showThinking && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            Thinking…
          </div>
        )}

        {state.finalText && (
          <article className="prose prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {state.finalText}
            </ReactMarkdown>
          </article>
        )}

        {state.status === "running" && (pairs.length > 0 || state.finalText) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={12} className="animate-spin" />
            Working…
          </div>
        )}

        {state.status === "error" && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs">
            <AlertTriangle size={14} className="mt-0.5 text-destructive" />
            <span className="text-destructive">
              {state.errorMessage ?? "agent error"}
            </span>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// pairing tool_call ↔ tool_result
// ---------------------------------------------------------------------------

interface ToolPair {
  call: ToolCallRecord;
  result: ToolResultRecord | null;
}

function pairToolEvents(events: AgentEvent[]): ToolPair[] {
  const out: ToolPair[] = [];
  const byId = new Map<string, ToolPair>();
  for (const ev of events) {
    if (ev.kind === "tool_call") {
      const pair: ToolPair = { call: ev.call, result: null };
      out.push(pair);
      byId.set(ev.call.id, pair);
    } else if (ev.kind === "tool_result") {
      const pair = byId.get(ev.result.id);
      if (pair) pair.result = ev.result;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// per-step rendering
// ---------------------------------------------------------------------------

function ToolStep({ pair }: { pair: ToolPair }) {
  const [open, setOpen] = useState(pair.call.name === "run_sql");
  const { call, result } = pair;
  const summary = renderToolSummary(call, result);
  const failed = result && !result.ok;

  return (
    <div className="rounded-md border border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <ToolIcon name={call.name} />
        <span className="font-mono">{call.name}</span>
        <span className="text-muted-foreground">{summary}</span>
        {!result && <Loader2 size={11} className="ml-auto animate-spin" />}
        {failed && <AlertTriangle size={11} className="ml-auto text-destructive" />}
      </button>
      {open && (
        <div className="border-t border-border px-2 py-2 text-xs space-y-2">
          <ArgsBlock args={call.args} />
          {result && <ResultBlock name={call.name} display={result.display} />}
          {!result && (
            <div className="text-muted-foreground">running…</div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolIcon({ name }: { name: string }) {
  const props = { size: 12, className: "text-muted-foreground" };
  switch (name) {
    case "list_tables":
      return <ListTree {...props} />;
    case "get_table":
      return <Table2 {...props} />;
    case "get_relations":
      return <Network {...props} />;
    case "run_sql":
      return <Database {...props} />;
    default:
      return <Wrench {...props} />;
  }
}

function renderToolSummary(call: ToolCallRecord, result: ToolResultRecord | null): string {
  if (!result) {
    if (call.name === "list_tables") {
      const a = call.args as { filter?: string } | undefined;
      return a?.filter ? `(filter="${a.filter}")` : "(all)";
    }
    if (call.name === "get_table") {
      const a = call.args as { schema?: string; name?: string } | undefined;
      return a?.schema && a?.name ? `→ ${a.schema}.${a.name}` : "";
    }
    if (call.name === "run_sql") {
      const a = call.args as { sql?: string } | undefined;
      return a?.sql ? `· ${a.sql.replace(/\s+/g, " ").slice(0, 60)}…` : "";
    }
    return "";
  }
  if (!result.ok) {
    const d = result.display as { error?: string } | undefined;
    return `· ${d?.error ?? "failed"}`;
  }
  const d = result.display as Record<string, unknown>;
  switch (call.name) {
    case "list_tables":
      return `→ ${d.count} tables`;
    case "get_table":
      return `→ loaded`;
    case "get_relations":
      return `→ ${d.count} edges`;
    case "run_sql": {
      const rc = d.rowCount as number | undefined;
      const tr = d.truncated ? "+" : "";
      const ms = d.durationMs as number | undefined;
      return `→ ${rc ?? 0}${tr} rows · ${ms ?? 0}ms`;
    }
    default:
      return "";
  }
}

function ArgsBlock({ args }: { args: unknown }) {
  if (args === undefined || args === null) return null;
  const text =
    typeof args === "string" ? args : JSON.stringify(args, null, 2);
  if (!text || text === "{}") return null;
  return (
    <div>
      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        args
      </div>
      <pre className="overflow-x-auto rounded bg-background px-2 py-1 text-[11px]">
        <code>{text}</code>
      </pre>
    </div>
  );
}

function ResultBlock({ name, display }: { name: string; display: unknown }) {
  if (name === "run_sql") return <SqlResultBlock display={display} />;
  if (name === "get_table") return null; // markdown is huge — skip in the UI
  return (
    <div>
      <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        result
      </div>
      <pre className="overflow-x-auto rounded bg-background px-2 py-1 text-[11px]">
        <code>{JSON.stringify(display, null, 2)}</code>
      </pre>
    </div>
  );
}

function SqlResultBlock({ display }: { display: unknown }) {
  const d = display as
    | {
        ok: true;
        sql: string;
        columns: string[];
        rows: Record<string, unknown>[];
        rowCount: number;
        truncated: boolean;
        durationMs: number;
      }
    | { ok: false; sql?: string; error: string };
  if (!d.ok) {
    return (
      <div className="space-y-1">
        {d.sql && <SqlBlock sql={d.sql} />}
        <p className="text-[11px] text-destructive">{d.error}</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <SqlBlock sql={d.sql} />
      {d.rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No rows.</p>
      ) : (
        <ResultTable columns={d.columns} rows={d.rows} truncated={d.truncated} />
      )}
    </div>
  );
}

function SqlBlock({ sql }: { sql: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="relative rounded border border-border bg-background">
      <button
        onClick={copy}
        className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check size={10} /> : <Copy size={10} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="overflow-x-auto p-2 pr-14 text-[11px]">
        <code>{sql}</code>
      </pre>
    </div>
  );
}

function ResultTable({
  columns,
  rows,
  truncated,
}: {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded border border-border">
      <table className="min-w-full text-[11px]">
        <thead className="bg-muted">
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                className="px-2 py-1 text-left font-medium text-muted-foreground"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-border">
              {columns.map((c) => (
                <td key={c} className="px-2 py-1 align-top">
                  {previewCell(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <p className="px-2 py-1 text-[10px] text-muted-foreground">
          Output truncated to first {rows.length} rows.
        </p>
      )}
    </div>
  );
}

const mdComponents = {
  // Render fenced ```sql blocks with a Copy button so the user can re-run them.
  pre(props: { children?: React.ReactNode }) {
    return <>{props.children}</>;
  },
  code(props: { className?: string; children?: React.ReactNode }) {
    const className = props.className ?? "";
    const isBlock = /language-/.test(className);
    if (!isBlock) {
      return (
        <code className="rounded bg-muted px-1 py-0.5 text-[12px]">
          {props.children}
        </code>
      );
    }
    const text = String(props.children ?? "").replace(/\n$/, "");
    return <SqlBlock sql={text} />;
  },
};

function previewCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.length > 80 ? v.slice(0, 79) + "…" : v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint")
    return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 79) + "…" : s;
  } catch {
    return String(v);
  }
}

