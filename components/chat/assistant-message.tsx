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
  Info,
  Loader2,
  Play,
  Table2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import type { NL2SqlResult } from "@/lib/llm";
import type { ExecuteResult } from "@/lib/sql";

export type AssistantTurnState =
  | { status: "thinking"; result: null; execution: null }
  | { status: "failed"; result: null; execution: null; error: string }
  | {
      status: "ready";
      result: NL2SqlResult;
      execution:
        | null
        | { status: "running" }
        | { status: "done"; result: ExecuteResult }
        | { status: "error"; message: string };
    };

export function AssistantMessage({
  state,
  onExecute,
}: {
  state: AssistantTurnState;
  onExecute: () => void;
}) {
  if (state.status === "thinking") {
    return (
      <Card>
        <CardBody className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          Thinking…
        </CardBody>
      </Card>
    );
  }
  if (state.status === "failed") {
    return (
      <Card className="border-destructive/30">
        <CardBody className="flex items-start gap-2 text-sm">
          <AlertTriangle size={14} className="mt-0.5 text-destructive" />
          <span className="text-destructive">{state.error}</span>
        </CardBody>
      </Card>
    );
  }

  const { result, execution } = state;
  const running = execution?.status === "running";
  const isAnswer = result.mode === "answer";

  return (
    <Card>
      <CardBody className="space-y-3">
        {isAnswer ? (
          <div className="flex items-start gap-2">
            <Info
              size={14}
              className="mt-1 shrink-0 text-muted-foreground"
              aria-label="metadata answer"
            />
            <article className="prose prose-sm max-w-none flex-1">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {result.notes || "_(empty)_"}
              </ReactMarkdown>
            </article>
          </div>
        ) : (
          result.notes && <p className="text-sm">{result.notes}</p>
        )}

        {result.warnings.length > 0 && (
          <ul className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground space-y-1">
            {result.warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <AlertTriangle size={12} className="mt-0.5" />
                {w}
              </li>
            ))}
          </ul>
        )}

        {result.pickedTables.length > 0 && (
          <PickedTables tables={result.pickedTables} />
        )}

        {!isAnswer && (
          <>
            <SqlBlock sql={result.sql} />

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={onExecute}
                disabled={running}
                variant="primary"
              >
                {running ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Play size={12} />
                )}
                {running ? "Running…" : "Run"}
              </Button>
              {execution?.status === "done" && execution.result.ok && (
                <span className="text-[11px] text-muted-foreground">
                  {execution.result.rowCount}
                  {execution.result.truncated ? "+" : ""} rows ·{" "}
                  {execution.result.durationMs}ms
                </span>
              )}
            </div>

            {execution?.status === "done" && (
              <ExecutionResult exec={execution.result} />
            )}
            {execution?.status === "error" && (
              <p className="text-xs text-destructive">{execution.message}</p>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function PickedTables({
  tables,
}: {
  tables: { schema: string; name: string; reason: string }[];
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {tables.length} table{tables.length === 1 ? "" : "s"} used
      </button>
      <div className="flex flex-wrap gap-1.5">
        {tables.map((t) => (
          <span
            key={`${t.schema}.${t.name}`}
            title={t.reason}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-accent px-1.5 py-0.5 text-[11px] font-mono"
          >
            <Table2 size={10} className="text-muted-foreground" />
            <span className="text-muted-foreground">{t.schema}.</span>
            <span>{t.name}</span>
          </span>
        ))}
      </div>
      {expanded && (
        <ul className="space-y-1 rounded-md border border-border bg-muted/40 p-2 text-[11px]">
          {tables.map((t) => (
            <li key={`${t.schema}.${t.name}-r`} className="leading-tight">
              <span className="font-mono text-muted-foreground">
                {t.schema}.{t.name}
              </span>
              <span className="mx-1 text-muted-foreground">—</span>
              <span>{t.reason}</span>
            </li>
          ))}
        </ul>
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
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="relative rounded-md border border-border bg-muted">
      <button
        onClick={copy}
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="overflow-x-auto p-3 pr-16 text-xs">
        <code>{sql}</code>
      </pre>
    </div>
  );
}

function ExecutionResult({ exec }: { exec: ExecuteResult }) {
  if (!exec.ok) {
    if (exec.errors.kind === "guard") {
      return (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
          <p className="mb-1 font-medium text-destructive">
            Guard rejected the query.
          </p>
          <ul className="list-disc pl-4 text-muted-foreground">
            {exec.errors.details.map((e, i) => (
              <li key={i}>{describe(e)}</li>
            ))}
          </ul>
        </div>
      );
    }
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs">
        <p className="font-medium text-destructive">Execution error</p>
        <p className="mt-1 font-mono text-[11px]">{exec.errors.message}</p>
      </div>
    );
  }
  if (exec.rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No rows returned.</p>
    );
  }
  const cols = exec.columns.map((c) => c.name);
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="min-w-full text-xs">
        <thead className="bg-muted">
          <tr>
            {cols.map((c) => (
              <th
                key={c}
                className="px-2 py-1.5 text-left font-medium text-muted-foreground"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {exec.rows.map((row, i) => (
            <tr key={i} className="border-t border-border">
              {cols.map((c) => (
                <td key={c} className="px-2 py-1 align-top">
                  {previewCell(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {exec.truncated && (
        <p className="px-2 py-1 text-[11px] text-muted-foreground">
          Output truncated to first {exec.rows.length} rows.
        </p>
      )}
    </div>
  );
}

function describe(e: { kind: string; firstKeyword?: string; keyword?: string }): string {
  switch (e.kind) {
    case "non-read":
      return `Only SELECT/WITH/EXPLAIN/VALUES allowed; got ${e.firstKeyword}`;
    case "forbidden-keyword":
      return `Forbidden keyword: ${e.keyword}`;
    case "multiple-statements":
      return "Multiple SQL statements not allowed";
    case "comment-injection":
      return "Suspicious comment markers";
    case "empty":
      return "Empty SQL";
    default:
      return e.kind;
  }
}

function previewCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string")
    return v.length > 80 ? v.slice(0, 79) + "…" : v;
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
