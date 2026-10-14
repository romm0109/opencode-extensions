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

- `/goal [--tokens <budget>] <objective>` starts one session goal; `/goal edit [--tokens <budget>] <objective>`, `pause`, `resume`, `status`, and `clear` (`stop`) manage it. An incomplete Goal automatically continues only after native settled idle. `goal_complete` requires the current Goal ID and evidence; `goal_blocked` requires three Goal responses and an evidenced recurring external impasse. `goal_wait` suspends continuation until external input, explicit resume, or an optional persisted safety deadline (minimum ten seconds). Default safety limits pause after 25 responses or three repeated tool-free outputs. Goal and Plan cannot own the same session simultaneously. `/goal-manager` offers native lifecycle actions, status with active elapsed time, and persistent configurable safety limits. See [Goal behavior and verification](./docs/goal.md) for budget semantics and remaining differences.
- `/plan <task>` switches to OpenCode's Plan agent and starts read-only planning. `plan_complete` stores a plan for review, followed by explicit `/plan approve` and `/plan implement`. Matching mutation tools are removed from planning context and matching permission actions are denied. Source allowlists, unsafe shell parsing, settings, export/save, and fresh-session handoff are not implemented.
- `update_progress` replaces a bounded checklist with at most 50 rows, 503 grapheme clusters per row, and at most one `in_progress` row. An empty list clears progress. The TUI reconstructs state from the active transcript branch; stale storage snapshots are not injected into model context.
- `/notes`, `/recall`, and `notes_*` / `recall_*` tools provide local storage CRUD and search. Recall quotes are marked but cannot be inserted at the editor cursor; notes are plugin storage records rather than Markdown files.
- `/file-context <path> [start:end]` reads bounded project-local files; `/tool [name]` inspects registered tool schemas; `/worktree list|add|remove` uses the native project API without force removal.
- `/analytics` reports content-free event/token/cost metrics from the public server event stream. No external reporting service is contacted.

Goal starts/resumes, automatic continuations and safety wakes, and Plan starts/resumes intentionally submit prompts and may incur the configured provider's normal model costs. Informational commands do not resume generation. State is stored in OpenCode plugin storage.

## Terminal UI entry

The package-directory entry in `opencode.jsonc` above loads both the server plugin and its paired root `tui.js` in OpenCode 2.0.28. No duplicate CLI plugin entry is needed. The paired-directory route is verified with the real native terminal host; do not substitute a standalone `tui.js` path for the package directory.

The TUI plugin replaces the prompt footer with one selected presentation: a native statusline or a Starship-style footer. `/footer-mode statusline|starship|off` switches modes; `/statusline` opens its profile picker and `/statusline-preset minimal|balanced|verbose` selects a profile directly; `/starship-preset <name>` applies one of the 13 upstream Pi Starship templates; `/starship-template` accepts custom TOML with a format, module tables, and palettes. These choices persist in OpenCode plugin storage. Supported custom module fields are `format`, `symbol`, `style`, and `disabled`; other module fields are retained but ignored by this renderer. The Starship renderer uses host-reported session/model/token/cost/VCS data, fits each line to terminal cell width, and does not start a shell or Starship process. Modules without a corresponding public CLI data source render empty.

`/workflow`, `/cache-hit-monitor`, `/stamp`, and `/tui-kit-showcase` open session panels. The workflow panel reads completed `update_progress` tool inputs from the selected session's current message list, so switching to a fork/reverted branch follows that branch. If compaction removes the tool input, the panel has no verified checklist to show; it does not recover state from server plugin storage.

The TUI entry uses the pinned `@opentui/solid` and `solid-js` runtime dependencies in this package; OpenCode's CLI supplies the v2 plugin host, but does not resolve these package imports on a local plugin's behalf.

This is a native presentation mapping, not a drop-in port of Pi's TUI component library. OpenCode v2.0.28 has a public replaceable prompt footer and session panel but no transcript-row decoration slot, so `/stamp` summarizes available assistant/tool timing instead of adding Pi's inline stamps. Cache rates use server-reported token counts and do not estimate cost or savings. The showcase demonstrates enabled/disabled actions, busy state, selection, input, confirmation, search, and cancellation through native panel keyboard events. Statusline profiles are compact host-data profiles; Pi's extension status registry, complete icon catalog, and periodic module refresh lifecycle are not exposed by this TUI context.

## Coverage and known gaps

See [the parity ledger](./docs/parity.md) for every current manifest extension and the `pi-tui-kit` library. Remaining gaps include custom Pi transcript/editor UI, Pi-owned OAuth storage and account switching, parts of peer networking/cloud sync, opaque provider checkpoint replay, and service-specific context behavior.

The plugin API and local install flow follow the [OpenCode v2 plugin guide](https://opencode.ai/v2/docs/build/plugins); this package targets the pinned [OpenCode 2.0.28 declarations](https://www.npmjs.com/package/@opencode/plugin/v/2.0.28).

## Development

```sh
npm install --ignore-scripts
npm run typecheck
npm test
```

The MIT license and original copyright attribution are retained from the upstream repository.
