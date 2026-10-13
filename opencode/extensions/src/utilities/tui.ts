import type { Context } from "@opencode/plugin/tui/context";
import { formatPullRequest, type PullRequestSummary, readCurrentPullRequest } from "./github-pr.ts";
import { fetchQuotes, formatQuote, mergeQuoteResults, normalizeSymbols, type QuoteResult } from "./ticker.ts";

const PANEL = "romm0109-utilities";
type JSXRuntime = { jsx(type: string, props: Record<string, unknown>): unknown };
type UtilityState = {
  symbols: string[];
  quotes: QuoteResult[];
  updatedAt?: number;
  loading: boolean;
  activeExecutions: number;
  pr?: PullRequestSummary;
  prError?: string;
};

/** Native OpenCode v2 TUI adapter. This exports a registrar so server-only loading never imports Solid or OpenTUI. */
export async function registerUtilityTui(
  ctx: Context,
  loadJSX: () => Promise<JSXRuntime> = async () => {
    const moduleName: string = "@opentui/solid/jsx-runtime";
    return (await import(moduleName)) as unknown as JSXRuntime;
  },
): Promise<() => void> {
  const jsx = await loadJSX();
  const [state, update] = ctx.storage.store<UtilityState>("romm0109.utilities.tui.v1", {
    initial: { symbols: [], quotes: [], loading: false, activeExecutions: 0 },
  });
  const controller = new AbortController();
  const activeExecutions = new Set<string>();
  const stopStarted = ctx.data.on("session.execution.started", (event) => {
    activeExecutions.add(event.data.sessionID);
    update((draft) => {
      draft.activeExecutions = activeExecutions.size;
    });
  });
  const finished = (event: { data: { sessionID: string } }) => {
    activeExecutions.delete(event.data.sessionID);
    update((draft) => {
      draft.activeExecutions = activeExecutions.size;
    });
  };
  const stopSuccess = ctx.data.on("session.execution.succeeded", finished);
  const stopFailure = ctx.data.on("session.execution.failed", finished);
  const stopInterrupted = ctx.data.on("session.execution.interrupted", finished);
  ctx.ui.slot({
    append: "session.panel",
    render: (input) => {
      if (input.name !== PANEL) return null as never;
      const rows: unknown[] = [text(jsx, "OpenCode utility extensions")];
      rows.push(
        text(
          jsx,
          `Caffeinate · ${state.activeExecutions ? `active for ${state.activeExecutions} execution(s)` : "idle"}; inhibitor follows server execution lifecycle`,
        ),
      );
      rows.push(
        text(
          jsx,
          state.pr
            ? formatPullRequest(state.pr)
            : state.prError
              ? `GitHub PR · ${state.prError}`
              : "GitHub PR · use /github-pr to refresh the current branch",
        ),
      );
      rows.push(
        text(
          jsx,
          state.loading
            ? "Ticker · fetching quotes…"
            : state.quotes.length
              ? `Ticker · ${state.quotes.map(formatQuote).join(" · ")}`
              : "Ticker · no symbols configured; use /ticker to select symbols",
        ),
      );
      if (state.updatedAt)
        rows.push(text(jsx, `Quotes refreshed at ${new Date(state.updatedAt).toLocaleTimeString()}`));
      rows.push(
        text(
          jsx,
          "Commands: /github-pr · /ticker [SYMBOLS] · /caffeinate [status|on|off|display|sleep] · /dotenv load <file> · tools: lsp_diagnostics, lsp_fix",
        ),
      );
      return jsx.jsx("box", { flexDirection: "column", padding: 1, gap: 1, children: rows }) as never;
    },
  });
  ctx.keymap.layer(() => ({
    mode: "base",
    commands: [
      {
        id: "romm0109.utilities.open",
        title: "Utility extensions",
        description: "Open GitHub PR, ticker, and keep-awake status",
        palette: true,
        slash: { name: "utilities" },
        run: () => {
          ctx.ui.panel.open(PANEL);
        },
      },
      {
        id: "romm0109.utilities.github",
        title: "Refresh GitHub PR status",
        palette: true,
        slash: { name: "github-pr" },
        run: async () => {
          if (controller.signal.aborted) return;
          const route = ctx.ui.router.current();
          const sessionID =
            route.type === "session" ? route.sessionID : ctx.ui.tabs.list().find((tab) => tab.active)?.sessionID;
          const root = sessionID ? ctx.data.session.root(sessionID) : ctx.location?.directory;
          if (!root) {
            update((draft) => {
              draft.prError = "No project session is selected.";
            });
            return;
          }
          try {
            const pr = await readCurrentPullRequest(root, controller.signal);
            if (controller.signal.aborted) return;
            update((draft) => {
              draft.pr = pr;
              draft.prError = undefined;
            });
            ctx.ui.panel.open(PANEL);
          } catch (error) {
            if (controller.signal.aborted) return;
            update((draft) => {
              draft.pr = undefined;
              draft.prError = error instanceof Error ? error.message : String(error);
            });
            ctx.ui.panel.open(PANEL);
          }
        },
      },
      {
        id: "romm0109.utilities.ticker",
        title: "Manage or refresh stock quotes",
        palette: true,
        slash: { name: "ticker", arguments: true },
        run: async (input) => {
          if (controller.signal.aborted) return;
          const argument = input?.trim() ?? "";
          if (argument === "help") {
            ctx.ui.toast.show({
              title: "Ticker",
              message: "Usage: /ticker [SYMBOL ...] | /ticker refresh | /ticker reset | /ticker help",
              variant: "info",
            });
            return;
          }
          if (argument === "reset") {
            ctx.ui.toast.show({
              title: "Ticker",
              message: "No default symbol list is available to reset. Choose symbols explicitly.",
              variant: "info",
            });
            return;
          }
          const value =
            argument && argument !== "refresh"
              ? argument
              : state.symbols.length
                ? state.symbols.join(" ")
                : await ctx.ui.dialog.prompt({
                    title: "Ticker symbols",
                    description: "Enter up to ten Yahoo Finance symbols, separated by spaces or commas.",
                    placeholder: "MSFT NVDA",
                  });
          if (value === undefined || controller.signal.aborted) return;
          try {
            const symbols = normalizeSymbols(value ? [value] : [], true);
            update((draft) => {
              draft.symbols = symbols;
              draft.loading = symbols.length > 0;
            });
            ctx.ui.panel.open(PANEL);
            if (!symbols.length) {
              update((draft) => {
                draft.quotes = [];
                draft.updatedAt = undefined;
                draft.loading = false;
              });
              return;
            }
            const quotes = mergeQuoteResults(state.quotes, await fetchQuotes(symbols, controller.signal));
            if (controller.signal.aborted) return;
            update((draft) => {
              draft.quotes = quotes;
              draft.updatedAt = Date.now();
              draft.loading = false;
            });
          } catch (error) {
            if (controller.signal.aborted) return;
            update((draft) => {
              draft.loading = false;
            });
            ctx.ui.toast.show({
              title: "Ticker",
              message: error instanceof Error ? error.message : String(error),
              variant: "warning",
            });
          }
        },
      },
      {
        id: "romm0109.utilities.caffeinate",
        title: "Caffeinate status",
        palette: true,
        slash: { name: "caffeinate", arguments: true },
        run: async (input) => {
          const route = ctx.ui.router.current();
          const sessionID =
            route.type === "session" ? route.sessionID : ctx.ui.tabs.list().find((tab) => tab.active)?.sessionID;
          if (!sessionID) {
            ctx.ui.toast.show({
              title: "Caffeinate",
              message: "Open a session before changing keep-awake settings.",
              variant: "warning",
            });
            return;
          }
          try {
            await ctx.client.session.command({ sessionID, name: "caffeinate", text: input?.trim() ?? "" });
            ctx.ui.panel.open(PANEL);
          } catch (error) {
            ctx.ui.toast.show({
              title: "Caffeinate",
              message: error instanceof Error ? error.message : String(error),
              variant: "error",
            });
          }
        },
      },
    ],
  }));
  // The TUI owns only listeners and display state. It never starts or stops OS inhibitors.
  return () => {
    controller.abort(new DOMException("Utility TUI disposed", "AbortError"));
    stopStarted();
    stopSuccess();
    stopFailure();
    stopInterrupted();
  };
}

function text(jsx: JSXRuntime, children: string) {
  return jsx.jsx("text", { children });
}
