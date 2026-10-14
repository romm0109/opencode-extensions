# Utility extension integration

This group ports `pi-github-pr`, `pi-caffeinate`, `pi-ticker`, `pi-dotenv`, and `pi-lsp` from the MIT-licensed [`narumiruna/pi-extensions`](https://github.com/narumiruna/pi-extensions) project. The implementations are in `src/utilities/` and intentionally do not alter the workflow plugin's shared entrypoints.

## Integration patch

In `src/index.ts`, add:

```ts
import { registerUtilityExtensions } from "./utilities/index.ts"
```

Inside `Plugin.define({ id: "romm0109.workflow", async setup(ctx) { ... } })`, call it alongside the other extension registrars:

```ts
const cleanupUtilities = await registerUtilityExtensions(ctx)
```

Await `cleanupUtilities()` in the function returned from `setup`, together with the existing lifecycle cleanups. This is required to abort the event subscription and release any active OS inhibitor on plugin shutdown.

In `src/tui.ts`, import `registerUtilityTui` and call `const cleanupUtilitiesTui = await registerUtilityTui(ctx)` from the TUI plugin's `setup`; return that cleanup. The TUI adapter uses OpenCode's published `session.panel`, keymap, event, and storage APIs. It intentionally does not import Pi TUI components.

No new runtime dependency is required beyond existing Node built-ins, the already-declared `@opencode/plugin` 2.0.28 API, and the existing TUI runtime peer dependencies. `gh` is an optional external CLI for GitHub PR status. `typescript-language-server`, `pyright-langserver`, `rust-analyzer`, `gopls`, and `clangd` are optional external LSP programs.

## Behavior and boundaries

- `/github-pr` reads the current branch through `gh pr view`; authentication stays in the user's `gh` installation. The plugin never reads or prints credential values.
- Caffeinate follows OpenCode session execution start/end/failure/interruption events and has idempotent cleanup. Its enabled flag and mode persist in OpenCode plugin storage. `/caffeinate off` disables automatic inhibition until `/caffeinate on`; `/caffeinate sleep` permits display sleep and `/caffeinate display` also blocks display idle. OS inhibitors are not started in tests.
- `stock_quote` and `/ticker <SYMBOL...>` fetch Yahoo chart quotes only when explicitly called. Symbols are validated and bounded to ten; no quote polling runs in the background. The TUI stores its own selected symbols and displays the latest explicit refresh.
- `/dotenv load <path>` is explicit opt-in. It fills only missing process environment variables, keeps existing values, emits variable names only, and never emits values. Values are process-wide and available to trusted plugins and inherited child processes until OpenCode restarts.
- `lsp_diagnostics` and `lsp_fix` use configured server argv and the public Language Server Protocol. `lsp_fix` previews by default; writing requires `write: true`. File paths are restricted to regular files under the chosen workspace root. Default command routes are optional; custom servers may be supplied in this plugin's options as `servers: [{ name, command, args, extensions, languageId, env? }]`, and `timeoutMs` is capped at 60 seconds.

OpenCode v2 has separate server and CLI/TUI plugin APIs, so server commands/tools and TUI panels require the two integration calls above. Exact compatibility for source-only Pi status-line widgets and persistent Pi language-server sessions is not claimed: the TUI uses a native panel, and this initial LSP adapter creates a bounded server process per tool request.
