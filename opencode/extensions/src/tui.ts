import type { Context } from "@opencode/plugin/tui/context";

type JsonRecord = Record<string, unknown>;
type Element = unknown;
type JSXRuntime = { jsx: (type: string, props: Record<string, unknown>) => Element };
type TuiDependencies = { loadJSX?: () => Promise<JSXRuntime> };

const JSX_RUNTIME = "@opentui/solid/jsx-runtime";
const PANEL = {
  workflow: "romm0109-workflow",
  cache: "romm0109-cache",
  stamp: "romm0109-stamp",
  showcase: "romm0109-tui-showcase",
} as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip terminal controls before putting model- or user-authored text in a TUI node. */
export function safeTuiText(value: unknown, max = 160): string {
  if (typeof value !== "string") return "";
  const esc = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const ansi = new RegExp(`${esc}(?:\\][^${bell}]*(?:${bell}|${esc}\\\\)|\\[[0-?]*[ -/]*[@-~]|[@-_])`, "gu");
  const clean = value
    .replace(ansi, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return graphemeSlice(clean, max);
}

export type CacheOverview = {
  providerCount: number;
  requests: number;
  latestHitPercent: number | null;
  sessionHitPercent: number | null;
  read: number;
  write: number;
  uncachedInput: number;
};

/** Read only token counts that the OpenCode server itself reports; no pricing estimate is inferred. */
export function cacheOverview(messages: readonly unknown[]): CacheOverview {
  const assistants = messages.filter((message) => isRecord(message) && message.type === "assistant") as JsonRecord[];
  const cacheProviders = new Set<string>();
  for (const message of assistants) {
    const model = isRecord(message.model) ? message.model : undefined;
    const tokens = isRecord(message.tokens) ? message.tokens : undefined;
    const cache = tokens && isRecord(tokens.cache) ? tokens.cache : undefined;
    if (typeof model?.providerID === "string" && cache && (positive(cache.read) || positive(cache.write))) {
      cacheProviders.add(model.providerID);
    }
  }

  const samples = assistants.flatMap((message) => {
    const model = isRecord(message.model) ? message.model : undefined;
    const tokens = isRecord(message.tokens) ? message.tokens : undefined;
    const cache = tokens && isRecord(tokens.cache) ? tokens.cache : undefined;
    if (!model || typeof model.providerID !== "string" || !cacheProviders.has(model.providerID) || !tokens) return [];
    const input = nonNegative(tokens.input);
    const read = nonNegative(cache?.read);
    const write = nonNegative(cache?.write);
    const prompt = input + read + write;
    return prompt > 0 ? [{ input, read, write, hit: (read / prompt) * 100 }] : [];
  });
  const latest = samples.at(-1);
  const read = samples.reduce((sum, sample) => sum + sample.read, 0);
  const write = samples.reduce((sum, sample) => sum + sample.write, 0);
  const uncachedInput = samples.reduce((sum, sample) => sum + sample.input, 0);
  const prompt = read + write + uncachedInput;
  return {
    providerCount: cacheProviders.size,
    requests: samples.length,
    latestHitPercent: latest?.hit ?? null,
    sessionHitPercent: prompt > 0 ? (read / prompt) * 100 : null,
    read,
    write,
    uncachedInput,
  };
}

export type ProgressOverview = { steps: Array<{ text: string; status: string }>; completed: number } | undefined;

/** Recover the most recent completed update_progress tool input from the current transcript. */
export function progressOverview(messages: readonly unknown[]): ProgressOverview {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.type !== "assistant" || !Array.isArray(message.content)) continue;
    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.content[partIndex];
      if (!isRecord(part) || part.type !== "tool" || part.name !== "update_progress" || !isRecord(part.state)) continue;
      const state = part.state;
      if (state.status !== "completed" || !isRecord(state.input) || !Array.isArray(state.input.steps)) continue;
      if (
        !Array.isArray(state.content) ||
        !state.content.some(
          (part) =>
            isRecord(part) &&
            part.type === "text" &&
            typeof part.text === "string" &&
            part.text.startsWith("PROGRESS_ACCEPTED:"),
        )
      )
        continue;
      if (state.input.steps.length === 0) return undefined;
      const steps = state.input.steps.flatMap((step) => {
        if (
          !isRecord(step) ||
          typeof step.text !== "string" ||
          !step.text.trim() ||
          graphemeCount(step.text) > 503 ||
          !isProgressStatus(step.status)
        )
          return [];
        const text = safeTuiText(step.text, 503);
        if (!text) return [];
        return [{ text, status: step.status }];
      });
      if (
        steps.length > 50 ||
        state.input.steps.length !== steps.length ||
        steps.filter((step) => step.status === "in_progress").length > 1
      )
        continue;
      return { steps, completed: steps.filter((step) => step.status === "completed").length };
    }
  }
  return undefined;
}

function isProgressStatus(value: unknown): value is "pending" | "in_progress" | "completed" | "blocked" {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "blocked";
}

function graphemeCount(value: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length;
}

function graphemeSlice(value: string, limit: number): string {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)]
    .slice(0, Math.max(0, limit))
    .map((segment) => segment.segment)
    .join("");
}

export type StampOverview = { responseMs?: number; toolCount: number; completedAt?: number };

/** OpenCode v2 exposes message/tool timing, but not Pi's custom per-transcript-row decorations. */
export function stampOverview(messages: readonly unknown[]): StampOverview {
  let responseMs: number | undefined;
  let completedAt: number | undefined;
  let toolCount = 0;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.type === "assistant" && isRecord(message.time)) {
      const created = timestamp(message.time.created);
      const completed = timestamp(message.time.completed);
      if (created !== undefined && completed !== undefined && completed >= created) {
        responseMs = completed - created;
        completedAt = completed;
      }
      if (Array.isArray(message.content)) {
        toolCount += message.content.filter((part) => isRecord(part) && part.type === "tool").length;
      }
    }
  }
  return {
    ...(responseMs === undefined ? {} : { responseMs }),
    toolCount,
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function formatNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value)
    : "0";
}

function formatMoney(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(3)}` : "—";
}

function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "unavailable";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

function text(jsx: JSXRuntime, content: unknown): Element {
  return jsx.jsx("text", { children: safeTuiText(content, 500) });
}

function box(jsx: JSXRuntime, children: Element[]): Element {
  return jsx.jsx("box", { flexDirection: "column", padding: 1, gap: 1, children });
}

function getSessionID(ctx: Context, requested?: string): string | undefined {
  if (requested) return requested;
  const route = ctx.ui.router.current();
  if (route.type === "session") return route.sessionID;
  return ctx.ui.tabs.list().find((tab) => tab.active)?.sessionID;
}

function activeSnapshot(ctx: Context, sessionID: string | undefined) {
  if (!sessionID) return { session: undefined, messages: [] as unknown[], status: "idle" as const };
  return {
    session: ctx.data.session.get(sessionID) as unknown as JsonRecord | undefined,
    messages: ctx.data.session.message.list(sessionID) as unknown as unknown[],
    status: ctx.data.session.status(sessionID),
  };
}

function statusline(ctx: Context, jsx: JSXRuntime, sessionID?: string): Element {
  const selectedID = getSessionID(ctx, sessionID);
  const { session, status } = activeSnapshot(ctx, selectedID);
  const model = ctx.ui.model.current();
  if (!selectedID || !session) return text(jsx, "OpenCode · /workflow");
  const title = safeTuiText(session.title, 40) || selectedID.slice(0, 8);
  const modelLabel = model ? `${safeTuiText(model.providerID, 24)}/${safeTuiText(model.modelID, 36)}` : "default model";
  const tokens = isRecord(session.tokens) ? session.tokens : {};
  return text(
    jsx,
    `${status === "running" ? "● running" : "○ idle"} · ${title} · ${modelLabel} · ${formatMoney(session.cost)} · ↑${formatNumber(tokens.input)} ↓${formatNumber(tokens.output)} · /workflow`,
  );
}

function statusPanel(ctx: Context, jsx: JSXRuntime, sessionID: string | undefined): Element {
  const { session, messages, status } = activeSnapshot(ctx, sessionID);
  if (!session) return box(jsx, [text(jsx, "Workflow overview"), text(jsx, "No active session is selected.")]);
  const model = isRecord(session.model) ? session.model : ctx.ui.model.current();
  const title = safeTuiText(session.title, 120) || sessionID?.slice(0, 12) || "Current session";
  const progress = progressOverview(messages);
  const summary = [
    text(jsx, `Workflow · ${title}`),
    text(
      jsx,
      `State: ${status} · Model: ${model ? `${safeTuiText(model.providerID, 40)}/${safeTuiText(model.modelID, 60)}` : "default"}`,
    ),
    text(
      jsx,
      `Reported cost: ${formatMoney(session.cost)} · Tokens: input ${formatNumber(isRecord(session.tokens) ? session.tokens.input : 0)}, output ${formatNumber(isRecord(session.tokens) ? session.tokens.output : 0)}`,
    ),
    text(
      jsx,
      progress
        ? `Checklist: ${progress.completed}/${progress.steps.length} complete`
        : "Checklist: no update_progress result in this transcript",
    ),
  ];
  if (progress)
    summary.push(
      ...progress.steps.map((step) =>
        text(
          jsx,
          `${step.status === "completed" ? "✓" : step.status === "in_progress" ? "▶" : step.status === "blocked" ? "!" : "○"} ${step.text}`,
        ),
      ),
    );
  return box(jsx, summary);
}

function cachePanel(ctx: Context, jsx: JSXRuntime, sessionID: string | undefined): Element {
  const { messages } = activeSnapshot(ctx, sessionID);
  const overview = cacheOverview(messages);
  const percent = (value: number | null) => (value === null ? "unknown" : `${value.toFixed(1)}%`);
  return box(jsx, [
    text(jsx, "Prompt cache · OpenCode reported tokens"),
    text(jsx, `Requests with reported cache activity: ${overview.requests} · providers: ${overview.providerCount}`),
    text(
      jsx,
      `Latest hit rate: ${percent(overview.latestHitPercent)} · session hit rate: ${percent(overview.sessionHitPercent)}`,
    ),
    text(
      jsx,
      `Read ${formatNumber(overview.read)} · write ${formatNumber(overview.write)} · uncached input ${formatNumber(overview.uncachedInput)}`,
    ),
    text(jsx, "Hit rate = cache read / (input + cache read + cache write). No cost or savings estimate is inferred."),
  ]);
}

function stampPanel(ctx: Context, jsx: JSXRuntime, sessionID: string | undefined): Element {
  const { messages } = activeSnapshot(ctx, sessionID);
  const overview = stampOverview(messages);
  return box(jsx, [
    text(jsx, "Session timing · v2 message and tool timestamps"),
    text(jsx, `Latest completed assistant response: ${formatDuration(overview.responseMs)}`),
    text(jsx, `Assistant tool calls in visible history: ${overview.toolCount}`),
    text(
      jsx,
      "OpenCode has no transcript-row decoration slot; this panel is a timing summary, not inline Pi stamp parity.",
    ),
  ]);
}

function showcasePanel(jsx: JSXRuntime): Element {
  return box(jsx, [
    text(jsx, "OpenCode TUI extension showcase"),
    text(jsx, "Native slot: prompt.footer.status"),
    text(jsx, "Native panel: session.panel · opened by /workflow, /cache-hit-monitor, /stamp, or /tui-kit-showcase"),
    text(
      jsx,
      "This demonstrates OpenCode v2 slots and panels. Pi's modal editors, custom widgets, and toolkit APIs are not emulated here.",
    ),
  ]);
}

export function createTuiPlugin(dependencies: TuiDependencies = {}) {
  const loadJSX =
    dependencies.loadJSX ??
    (async () => {
      // TUI plugins run inside OpenCode's CLI process, which supplies @opentui/solid.
      const runtimeName: string = JSX_RUNTIME;
      return (await import(runtimeName)) as unknown as JSXRuntime;
    });

  return {
    id: "romm0109.workflow.tui",
    async setup(ctx: Context) {
      const jsx = await loadJSX();
      ctx.ui.slot({
        append: "prompt.footer.status",
        render: (input) => statusline(ctx, jsx, input.sessionID) as never,
      });
      ctx.ui.slot({
        append: "home.footer.status",
        render: () => statusline(ctx, jsx) as never,
      });
      ctx.ui.slot({
        append: "session.panel",
        render: (input) => {
          switch (input.name) {
            case PANEL.workflow:
              return statusPanel(ctx, jsx, input.sessionID) as never;
            case PANEL.cache:
              return cachePanel(ctx, jsx, input.sessionID) as never;
            case PANEL.stamp:
              return stampPanel(ctx, jsx, input.sessionID) as never;
            case PANEL.showcase:
              return showcasePanel(jsx) as never;
            default:
              return null as never;
          }
        },
      });
      ctx.keymap.layer(() => ({
        mode: "base",
        commands: [
          {
            id: "romm0109.workflow.open",
            title: "Workflow overview",
            description: "Open session status and progress",
            palette: true,
            slash: { name: "workflow" },
            run: () => {
              ctx.ui.panel.open(PANEL.workflow);
            },
          },
          {
            id: "romm0109.cache.open",
            title: "Cache hit monitor",
            description: "Inspect reported prompt cache token counts",
            palette: true,
            slash: { name: "cache-hit-monitor" },
            run: () => {
              ctx.ui.panel.open(PANEL.cache);
            },
          },
          {
            id: "romm0109.stamp.open",
            title: "Session timing",
            description: "Inspect message and tool timing summary",
            palette: true,
            slash: { name: "stamp" },
            run: () => {
              ctx.ui.panel.open(PANEL.stamp);
            },
          },
          {
            id: "romm0109.showcase.open",
            title: "TUI extension showcase",
            description: "Show native OpenCode TUI slots and panels",
            palette: true,
            slash: { name: "tui-kit-showcase" },
            run: () => {
              ctx.ui.panel.open(PANEL.showcase);
            },
          },
        ],
      }));
    },
  };
}

export default createTuiPlugin();
