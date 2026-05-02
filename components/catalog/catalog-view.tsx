"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils/cn";
import type {
  CatalogManifest,
  CatalogManifestTableEntry,
  RelationGraph,
} from "@/lib/catalog";
import { RelationDiagram } from "./relation-diagram";

interface Props {
  manifest: CatalogManifest;
  initialGraph: RelationGraph;
}

export function CatalogView({ manifest, initialGraph }: Props) {
  const [tab, setTab] = useState<"detail" | "graph">("detail");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<{
    schema: string;
    name: string;
  } | null>(() => {
    const first = manifest.tables[0];
    return first ? { schema: first.schema, name: first.name } : null;
  });
  const [tableMd, setTableMd] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [graph, setGraph] = useState<RelationGraph>(initialGraph);

  const filteredTables = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return manifest.tables.filter((t) =>
      q ? `${t.schema}.${t.name}`.toLowerCase().includes(q) : true,
    );
  }, [filter, manifest.tables]);

  const fetchedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!selected) return;
    const key = `${selected.schema}.${selected.name}`;
    if (fetchedKey.current === key) return;
    fetchedKey.current = key;
    setTableMd(null);
    fetch(
      `/api/catalog/table?schema=${encodeURIComponent(selected.schema)}&name=${encodeURIComponent(selected.name)}`,
    )
      .then(async (r) => {
        const data = (await r.json()) as { markdown?: string; error?: string };
        if (!r.ok) {
          setTableMd(`\`\`\`\n${data.error ?? "load failed"}\n\`\`\``);
        } else {
          setTableMd(data.markdown ?? "");
        }
      })
      .catch((err: Error) => setTableMd(`\`\`\`\n${err.message}\n\`\`\``));
  }, [selected]);

  async function refreshSelected() {
    if (!selected) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/catalog/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(selected),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        alert(data.error ?? "refresh failed");
        return;
      }
      // Force re-fetch of the md
      fetchedKey.current = null;
      setSelected({ ...selected });
      // Pull fresh graph too
      const g = await fetch("/api/catalog/relations").then((r) => r.json());
      if (g?.graph) setGraph(g.graph);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="grid h-[calc(100vh-49px)] grid-cols-[280px_1fr]">
      {/* Sidebar */}
      <aside className="flex min-h-0 flex-col border-r border-[var(--border)]">
        <div className="border-b border-[var(--border)] p-3 space-y-2">
          <div className="flex items-center justify-between text-xs text-[var(--muted-foreground)]">
            <span>{manifest.dialect}</span>
            <span title={manifest.connectionId} className="font-mono">
              {manifest.connectionId.slice(0, 8)}…
            </span>
          </div>
          <div className="relative">
            <Search
              size={14}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
            />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter tables…"
              className="pl-7 text-xs"
            />
          </div>
        </div>
        <ul className="flex-1 overflow-y-auto p-1.5">
          {filteredTables.map((t) => (
            <li key={`${t.schema}.${t.name}`}>
              <button
                onClick={() =>
                  setSelected({ schema: t.schema, name: t.name })
                }
                className={cn(
                  "block w-full truncate rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
                  selected?.schema === t.schema && selected?.name === t.name
                    ? "bg-[var(--accent)] font-medium"
                    : "hover:bg-[var(--accent)]",
                )}
                title={summarize(t)}
              >
                <span className="text-[var(--muted-foreground)]">
                  {t.schema}.
                </span>
                <span>{t.name}</span>
              </button>
            </li>
          ))}
          {filteredTables.length === 0 && (
            <li className="px-3 py-2 text-xs text-[var(--muted-foreground)]">
              No tables match.
            </li>
          )}
        </ul>
      </aside>

      {/* Main pane */}
      <section className="flex min-h-0 flex-col">
        <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2">
          <div className="flex gap-1">
            <TabButton
              active={tab === "detail"}
              onClick={() => setTab("detail")}
            >
              Table detail
            </TabButton>
            <TabButton active={tab === "graph"} onClick={() => setTab("graph")}>
              ER diagram
            </TabButton>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--muted-foreground)]">
              {manifest.tables.length} tables · built{" "}
              {new Date(manifest.builtAt).toLocaleString()}
            </span>
            {selected && tab === "detail" && (
              <Button
                variant="secondary"
                size="sm"
                onClick={refreshSelected}
                disabled={refreshing}
              >
                <RefreshCw
                  size={12}
                  className={refreshing ? "animate-spin" : ""}
                />
                Refresh
              </Button>
            )}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === "detail" ? (
            <div className="h-full overflow-y-auto px-6 py-4">
              {selected ? (
                tableMd === null ? (
                  <p className="text-sm text-[var(--muted-foreground)]">
                    Loading…
                  </p>
                ) : (
                  <article className="prose">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {tableMd}
                    </ReactMarkdown>
                  </article>
                )
              ) : (
                <p className="text-sm text-[var(--muted-foreground)]">
                  Pick a table from the sidebar.
                </p>
              )}
            </div>
          ) : (
            <RelationDiagram graph={graph} />
          )}
        </div>
      </section>
    </div>
  );
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-md px-3 py-1 text-xs transition-colors",
        active
          ? "bg-[var(--accent)] font-medium"
          : "text-[var(--muted-foreground)] hover:bg-[var(--accent)]",
      )}
    >
      {children}
    </button>
  );
}

function summarize(t: CatalogManifestTableEntry): string {
  const parts: string[] = [];
  parts.push(`${t.kind}, ${t.columnCount} cols`);
  if (t.primaryKey) parts.push(`pk(${t.primaryKey.columns.join(",")})`);
  if (t.foreignKeys.length) parts.push(`${t.foreignKeys.length} fk`);
  return parts.join(" · ");
}
