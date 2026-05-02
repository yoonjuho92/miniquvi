"use client";

import { useMemo } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import type { RelationGraph } from "@/lib/catalog";

/**
 * Cheap auto-layout: arrange nodes on a roughly-square grid. We don't ship
 * a real layout library — a grid is good enough for ~20-50 nodes, which is
 * the typical analytic schema size we expect to introspect.
 */
function gridLayout(graph: RelationGraph): { nodes: Node[]; edges: Edge[] } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length)));
  const dx = 240;
  const dy = 110;
  const nodes: Node[] = graph.nodes.map((n, i) => ({
    id: n.id,
    position: { x: (i % cols) * dx, y: Math.floor(i / cols) * dy },
    data: { label: `${n.schema}.${n.name}` },
    style: {
      fontSize: 12,
      padding: 8,
      borderRadius: 6,
      border: "1px solid var(--border)",
      background: "var(--background)",
      color: "var(--foreground)",
    },
  }));
  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    label: e.fromColumns.join(","),
    labelStyle: { fontSize: 10, fill: "var(--muted-foreground)" },
    style: { stroke: "var(--muted-foreground)" },
    type: "smoothstep",
    animated: false,
  }));
  return { nodes, edges };
}

export function RelationDiagram({ graph }: { graph: RelationGraph }) {
  const layout = useMemo(() => gridLayout(graph), [graph]);

  if (graph.nodes.length === 0) {
    return (
      <div className="grid h-full place-items-center text-sm text-[var(--muted-foreground)]">
        No tables to render.
      </div>
    );
  }

  return (
    <div className="h-full">
      <ReactFlow
        nodes={layout.nodes}
        edges={layout.edges}
        fitView
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
