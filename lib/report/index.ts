import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const tableSchema = z.object({
  caption: z.string().max(300).optional(),
  columns: z.array(z.string()).min(1).max(40),
  rows: z.array(z.array(cellSchema)).max(500),
});

const datasetSchema = z.object({
  label: z.string().min(1).max(80),
  data: z.array(z.number().nullable()).min(1).max(60),
});

const chartSchema = z.object({
  type: z.enum(["bar", "line", "pie", "doughnut"]),
  title: z.string().max(200).optional(),
  labels: z.array(z.string().max(60)).min(1).max(60),
  datasets: z.array(datasetSchema).min(1).max(8),
  stacked: z.boolean().optional(),
  xAxisLabel: z.string().max(60).optional(),
  yAxisLabel: z.string().max(60).optional(),
});

const sectionSchema = z.object({
  heading: z.string().min(1).max(200),
  body: z.string().max(4000).optional(),
  table: tableSchema.optional(),
  chart: chartSchema.optional(),
});

const kpiSchema = z.object({
  label: z.string().min(1).max(60),
  value: z.string().min(1).max(60),
  hint: z.string().max(120).optional(),
});

export const reportInputSchema = z.object({
  title: z.string().min(1).max(200),
  subtitle: z.string().max(300).optional(),
  summary: z.string().max(4000).optional(),
  kpis: z.array(kpiSchema).max(8).optional(),
  sections: z.array(sectionSchema).min(1).max(20),
});

export type ReportInput = z.infer<typeof reportInputSchema>;
type ChartSpec = z.infer<typeof chartSchema>;

export interface CreatedReport {
  id: string;
  url: string;
  path: string;
  title: string;
}

function reportRoot(): string {
  return process.env.REPORT_DIR || path.join(process.cwd(), ".reports");
}

function reportId(): string {
  return randomBytes(6).toString("hex");
}

export async function createReport(raw: unknown): Promise<CreatedReport> {
  const input = reportInputSchema.parse(raw);
  const id = reportId();
  const html = await renderHtml(input, id);
  const root = reportRoot();
  await fs.mkdir(root, { recursive: true });
  const filePath = path.join(root, `${id}.html`);
  await fs.writeFile(filePath, html, "utf8");
  return { id, url: `/api/report/${id}`, path: filePath, title: input.title };
}

export async function getReportHtml(id: string): Promise<string | null> {
  if (!/^[a-f0-9]{6,32}$/i.test(id)) return null;
  try {
    return await fs.readFile(path.join(reportRoot(), `${id}.html`), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

async function renderHtml(input: ReportInput, id: string): Promise<string> {
  const builtAt = new Date().toISOString();
  const subtitle = input.subtitle
    ? `<p class="subtitle">${escapeHtml(input.subtitle)}</p>`
    : "";
  const summary = input.summary
    ? `<section class="summary">${md(input.summary)}</section>`
    : "";
  const kpis = input.kpis?.length ? renderKpis(input.kpis) : "";

  const charts: { canvasId: string; config: unknown }[] = [];
  const sectionsHtml = input.sections
    .map((s, i) => renderSection(s, i, charts))
    .join("\n");

  const chartScripts = charts.length
    ? `
<script>${await getChartJsBundle()}</script>
<script>
(function () {
  const charts = ${safeJson(charts)};
  for (const { canvasId, config } of charts) {
    const el = document.getElementById(canvasId);
    if (el) new Chart(el, config);
  }
})();
</script>`
    : "";

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(input.title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<main>
  <header class="report-header">
    <h1>${escapeHtml(input.title)}</h1>
    ${subtitle}
    <p class="meta">Generated ${escapeHtml(builtAt)} · <span class="rid">${escapeHtml(id)}</span></p>
  </header>
  ${summary}
  ${kpis}
  ${sectionsHtml}
</main>${chartScripts}
</body>
</html>`;
}

function renderKpis(kpis: NonNullable<ReportInput["kpis"]>): string {
  const cards = kpis
    .map(
      (k) => `<div class="kpi">
      <div class="kpi-label">${escapeHtml(k.label)}</div>
      <div class="kpi-value">${escapeHtml(k.value)}</div>
      ${k.hint ? `<div class="kpi-hint">${escapeHtml(k.hint)}</div>` : ""}
    </div>`,
    )
    .join("\n");
  return `<section class="kpis">${cards}</section>`;
}

function renderSection(
  s: ReportInput["sections"][number],
  index: number,
  charts: { canvasId: string; config: unknown }[],
): string {
  const body = s.body ? md(s.body) : "";
  const table = s.table ? renderTable(s.table) : "";
  let chartHtml = "";
  if (s.chart) {
    const canvasId = `chart-${index}`;
    charts.push({ canvasId, config: buildChartConfig(s.chart) });
    chartHtml = `<div class="chart-wrap"><canvas id="${canvasId}"></canvas></div>`;
  }
  return `<section class="block">
    <h2>${escapeHtml(s.heading)}</h2>
    ${body}
    ${chartHtml}
    ${table}
  </section>`;
}

function renderTable(
  t: NonNullable<ReportInput["sections"][number]["table"]>,
): string {
  const caption = t.caption
    ? `<caption>${escapeHtml(t.caption)}</caption>`
    : "";
  const head = `<thead><tr>${t.columns
    .map((c) => `<th>${escapeHtml(c)}</th>`)
    .join("")}</tr></thead>`;
  const body = `<tbody>${t.rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (cell) =>
              `<td>${cell == null ? "—" : escapeHtml(String(cell))}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("")}</tbody>`;
  return `<table>${caption}${head}${body}</table>`;
}

// ---------------------------------------------------------------------------
// Chart.js
// ---------------------------------------------------------------------------

const PALETTE = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#f97316", // orange
  "#ec4899", // pink
] as const;

function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

interface ChartJsConfig {
  type: ChartSpec["type"];
  data: unknown;
  options: unknown;
}

function buildChartConfig(spec: ChartSpec): ChartJsConfig {
  const titlePlugin = spec.title
    ? {
        display: true,
        text: spec.title,
        font: { size: 14, weight: "600" },
        padding: { top: 4, bottom: 12 },
      }
    : { display: false };

  if (spec.type === "pie" || spec.type === "doughnut") {
    const ds = spec.datasets[0]!;
    return {
      type: spec.type,
      data: {
        labels: spec.labels,
        datasets: [
          {
            label: ds.label,
            data: ds.data,
            backgroundColor: spec.labels.map(
              (_, i) => PALETTE[i % PALETTE.length],
            ),
            borderColor: "#ffffff",
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: titlePlugin,
          legend: { position: "bottom", labels: { boxWidth: 12 } },
        },
      },
    };
  }

  // bar / line
  const datasets = spec.datasets.map((ds, i) => {
    const color = PALETTE[i % PALETTE.length]!;
    if (spec.type === "line") {
      return {
        label: ds.label,
        data: ds.data,
        borderColor: color,
        backgroundColor: withAlpha(color, 0.15),
        borderWidth: 2,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 4,
        fill: false,
      };
    }
    return {
      label: ds.label,
      data: ds.data,
      backgroundColor: color,
      borderColor: color,
      borderWidth: 0,
      borderRadius: 3,
    };
  });

  return {
    type: spec.type,
    data: { labels: spec.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: titlePlugin,
        legend: {
          display: spec.datasets.length > 1,
          position: "bottom",
          labels: { boxWidth: 12 },
        },
        tooltip: { mode: "index", intersect: false },
      },
      scales: {
        x: {
          stacked: !!spec.stacked,
          title: spec.xAxisLabel
            ? { display: true, text: spec.xAxisLabel }
            : undefined,
          grid: { display: false },
        },
        y: {
          stacked: !!spec.stacked,
          beginAtZero: true,
          title: spec.yAxisLabel
            ? { display: true, text: spec.yAxisLabel }
            : undefined,
          grid: { color: "#e2e8f0" },
        },
      },
    },
  };
}

let chartJsBundlePromise: Promise<string> | null = null;
function getChartJsBundle(): Promise<string> {
  if (!chartJsBundlePromise) {
    chartJsBundlePromise = (async () => {
      // Resolve from process.cwd() rather than import.meta.url. Under
      // Next.js / Turbopack, import.meta.url is a virtual `[project]/...`
      // URL that createRequire can't resolve against the real filesystem.
      // chart.js's package.json `exports` blocks direct subpath access to
      // dist/chart.umd.js, so we resolve the main entry (which IS exported)
      // and derive the UMD path next to it.
      const cwdRequire = createRequire(
        pathToFileURL(path.join(process.cwd(), "package.json")).href,
      );
      const mainPath = cwdRequire.resolve("chart.js");
      const bundlePath = path.join(path.dirname(mainPath), "chart.umd.js");
      return fs.readFile(bundlePath, "utf8");
    })();
  }
  return chartJsBundlePromise;
}

/**
 * Stringify a value safely for embedding inside `<script>...</script>`.
 * Escapes `<` / `>` / U+2028 / U+2029 so we never accidentally close the tag
 * or break the parser.
 */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ---------------------------------------------------------------------------
// markdown + escape
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

// Tiny markdown converter: paragraphs, **bold**, *italic*, `code`, lists.
// Operates on already-escaped text so authored HTML stays inert.
function md(src: string): string {
  const safe = escapeHtml(src);
  const lines = safe.split(/\r?\n/);
  const blocks: string[] = [];
  let para: string[] = [];
  let listItems: string[] = [];
  let listKind: "ul" | "ol" | null = null;

  function flushPara() {
    if (para.length) {
      blocks.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  }
  function flushList() {
    if (listKind && listItems.length) {
      const items = listItems.map((l) => `<li>${inline(l)}</li>`).join("");
      blocks.push(`<${listKind}>${items}</${listKind}>`);
    }
    listItems = [];
    listKind = null;
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const ulMatch = line.match(/^[-*]\s+(.*)$/);
    const olMatch = line.match(/^\d+\.\s+(.*)$/);
    if (ulMatch) {
      flushPara();
      if (listKind && listKind !== "ul") flushList();
      listKind = "ul";
      listItems.push(ulMatch[1]!);
    } else if (olMatch) {
      flushPara();
      if (listKind && listKind !== "ol") flushList();
      listKind = "ol";
      listItems.push(olMatch[1]!);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks.join("\n");
}

function inline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

const REPORT_CSS = `
:root {
  --bg: #ffffff;
  --fg: #0f172a;
  --muted: #64748b;
  --border: #e2e8f0;
  --soft: #f8fafc;
  --soft-2: #f1f5f9;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Pretendard", "Apple SD Gothic Neo", sans-serif;
  color: var(--fg);
  background: var(--soft);
  line-height: 1.55;
  font-size: 14px;
}
main {
  max-width: 820px;
  margin: 32px auto;
  padding: 32px 40px 40px;
  background: var(--bg);
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06), 0 1px 2px rgba(15, 23, 42, 0.04);
}
.report-header {
  border-bottom: 1px solid var(--border);
  padding-bottom: 18px;
  margin-bottom: 24px;
}
.report-header h1 { margin: 0; font-size: 24px; letter-spacing: -0.01em; }
.report-header .subtitle { margin: 6px 0 0; color: var(--muted); }
.report-header .meta { margin: 10px 0 0; font-size: 11px; color: var(--muted); }
.report-header .rid { font-family: ui-monospace, "JetBrains Mono", monospace; }
.summary p { margin: 0.6em 0; }
.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin: 20px 0 28px;
}
.kpi {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--soft);
}
.kpi-label {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.kpi-value { font-size: 22px; font-weight: 600; margin-top: 4px; }
.kpi-hint { font-size: 11px; color: var(--muted); margin-top: 4px; }
.block { margin: 28px 0; }
.block h2 {
  font-size: 16px;
  margin: 0 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.block p { margin: 0.6em 0; }
.chart-wrap {
  position: relative;
  height: 320px;
  margin: 14px 0;
}
table {
  border-collapse: collapse;
  width: 100%;
  margin: 10px 0;
  font-size: 13px;
}
caption {
  text-align: left;
  color: var(--muted);
  font-size: 11px;
  padding: 4px 0;
}
th, td {
  border-bottom: 1px solid var(--border);
  padding: 6px 10px;
  text-align: left;
  vertical-align: top;
}
th {
  background: var(--soft-2);
  font-weight: 600;
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
tr:hover td { background: var(--soft); }
ul, ol { padding-left: 1.4em; margin: 0.5em 0; }
li { margin: 0.2em 0; }
strong { font-weight: 600; }
em { font-style: italic; }
code {
  background: var(--soft-2);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.9em;
  font-family: ui-monospace, "JetBrains Mono", monospace;
}
@media print {
  body { background: #fff; }
  main { box-shadow: none; max-width: none; padding: 0; margin: 0; }
  .chart-wrap { break-inside: avoid; }
}
`;
