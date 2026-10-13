# OpenCode terminal extensions

This directory contains a native OpenCode v2 server plugin port, built against `@opencode/plugin` 2.0.28. It is an early port of selected workflow behavior from [`narumiruna/pi-extensions`](https://github.com/narumiruna/pi-extensions), not a drop-in conversion of all 34 Pi extensions.

The package also exposes a separate native OpenCode v2 CLI/TUI plugin at `@romm0109/opencode-extensions/tui` (or `./tui.js` from this checkout). Server plugins and TUI-only plugins load in different host contexts.

## Install locally

From an OpenCode project, add this directory to `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-extensions/opencode/extensions"]
}
```

Or copy the directory to `.opencode/plugins/romm0109-workflow/`. The plugin uses the host's `effect` runtime; keep `effect` external when bundling it. OpenCode's ordinary tool and permission handling remains in effect.

## Current server commands and tools

- `/goal <objective>` starts one session goal; `/goal edit`, `pause`, `resume`, `status`, and `clear` preserve lifecycle intent. Goals track observed assistant responses, cap generation output tokens to the remaining budget, interrupt when an observed budget/response limit is reached, and deny further tool execution at exhaustion. Input tokens become known only after the response, so total usage can exceed the configured budget by that response's input. A bounded `goal_wait` deadline is recorded but does not wake an idle session; automatic continuation, no-progress review, and the source manager UI remain unimplemented.
- `/plan <task>` switches to OpenCode's Plan agent and starts read-only planning. `plan_complete` stores a plan for review, followed by explicit `/plan approve` and `/plan implement`; `/plan finalize` prompts the active Plan agent to submit its final read-only plan. Planning, ready, and approved phases expose an explicit read-only tool allowlist and deny permission actions outside it; `/plan exit` restores the previous agent. The source's automatic finalization retry, allowlists, settings, export/save, and fresh-session handoff are not implemented.
- `/btw`, `/fleet`, `/subagents`, and `/herdr` provide native child-session workflows. Side-session answers are brought back as explicit synthetic transcript messages; Fleet opens native child tabs but does not launch terminal processes. Herdr is opt-in read-only discovery only. See [coordination boundaries](./docs/coordination-group.md).
- `/provider-accounts`, `/provider-usage`, and `/context-management` provide read-only provider inventory and local usage totals, plus explicit per-session native compaction. `typesafe_question` and `typesafe_search` are available only when explicitly invoked; semantic search requires `semantic_rerank: true` and a configured TypeSafe key. A configured OpenRouter fallback requires its own explicit option/key. Tests use mocked transports and make no external requests. Selective TypeSafe/Codex compaction replay remains disabled; see [provider/context boundaries](./docs/provider-context-modules.md).
- `update_progress` replaces a bounded checklist with at most 50 rows, 503 grapheme clusters per row, and at most one `in_progress` row. Invalid calls fail as tool errors; an empty list clears progress. The TUI reconstructs state only from accepted tool results on the active transcript branch; stale storage snapshots are not injected into model context.
- `/notes`, `/recall`, and `notes_*` / `recall_*` tools provide local storage CRUD and search. Recall quotes are marked but cannot be inserted at the editor cursor; notes are plugin storage records rather than Markdown files.
- `/file-context <path> [start:end]` reads bounded project-local files; `/tool [name]` inspects registered tool schemas; `/worktree list|add|remove` uses the native project API without force removal.
- `/analytics` reports content-free event/token/cost metrics from the public server event stream. No external reporting service is contacted.

Goal and Plan starts/resumes intentionally submit prompts and may incur the configured provider's normal model costs. Informational commands do not resume generation. State is stored in OpenCode plugin storage.

## Terminal UI entry

OpenCode loads CLI-only TUI plugins from `cli.json`, separately from server plugins in `opencode.jsonc`. Add the package export or local file path to the CLI plugin list using the [OpenCode v2 plugin configuration](https://opencode.ai/v2/docs/plugins/#terminal):

```json
{
  "plugins": ["/absolute/path/to/opencode-extensions/opencode/extensions/tui.js"]
}
```

The TUI plugin adds a status footer, `/workflow`, `/cache-hit-monitor`, `/stamp`, `/tui-kit-showcase`, and `/coordination` panels. `/fleet-open <session-id>` opens an owned child session in a native tab; `/btw-bring <session-id>` appends its latest answer to the parent transcript. The workflow panel reads completed `update_progress` tool inputs from the selected session's current message list, so switching to a fork/reverted branch follows that branch. If compaction removes the tool input, the panel has no verified checklist to show; it does not recover state from server plugin storage.

The TUI entry uses the pinned `@opentui/solid` and `solid-js` runtime dependencies in this package; OpenCode's CLI supplies the v2 plugin host, but does not resolve these package imports on a local plugin's behalf.

This is a partial UI mapping. OpenCode v2 has no transcript-row decoration slot, so `/stamp` summarizes available assistant/tool timing instead of adding Pi's inline stamps. Cache rates use server-reported token counts and do not estimate cost or savings. The showcase demonstrates native OpenCode slots and panels, not the full Pi TUI kit. The Pi Starship statusline needs controlled local subprocess execution, and Pi Ticker needs external quote fetching; neither is implemented by this TUI entry.

## Coverage and known gaps

See [the parity ledger](./docs/parity.md) for every current manifest extension and the `pi-tui-kit` library. Remaining major gaps include Pi's custom transcript/editor UI, Pi-owned OAuth storage and per-session credential switching, automatic session continuation, peer networking, cloud sync, and selective compaction replay.

The plugin API and local install flow follow the [OpenCode v2 plugin guide](https://opencode.ai/v2/docs/build/plugins); this package targets the pinned [OpenCode 2.0.28 declarations](https://www.npmjs.com/package/@opencode/plugin/v/2.0.28).

## Development

```sh
npm install --ignore-scripts
npm run typecheck
npm test
```

The MIT license and original copyright attribution are retained from the upstream repository.
