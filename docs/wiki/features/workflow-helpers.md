# Workflow helpers

## Summary

The OpenCode v2 package provides session-scoped Goal and Plan workflows, local notes and recall tools, file-context and worktree commands, content-free analytics, and a separate CLI/TUI plugin for footer status and session panels. It is a partial native port from the upstream Pi extension collection; the source-by-source ledger identifies the coverage boundary.

## Key behavior

- `/goal` starts, edits, pauses, resumes, inspects, and clears a session goal; explicit completion/block/wait tools and response/token limits guard managed work.
- `/plan <task>` switches to the Plan agent, enforces read-only tool permissions while planning, saves a completed plan for review, and requires explicit approval and implementation handoff.
- `update_progress` validates checklist snapshots; `/workflow` reconstructs the active branch from transcript tool messages rather than a divergent storage snapshot.
- `/notes`, `/recall`, `/file-context`, `/tool`, `/worktree`, and `/analytics` expose the current local server-port surface. Goal/Plan starts and resumes may submit model prompts; informational commands do not.
- The CLI/TUI plugin replaces v2 `prompt.footer` with exactly one selected statusline, Starship-style, or off presentation; it also contributes `home.footer.status`, `session.panel`, and keymap slash commands. It must be configured separately in `cli.json`.
- `/statusline` picks a minimal, balanced, or verbose profile; `/footer-mode` switches the mutually exclusive footer; `/starship-preset` selects one of 13 upstream TOML templates; `/starship-template` accepts a custom format, module tables, and palettes. Preferences persist in OpenCode plugin storage. The renderer fits by terminal cell width and uses public session/model/token/cost/VCS fields without running Starship or a shell.
- The Starship adapter supports module `format`, `symbol`, `style`, and `disabled`; other TOML module options are retained but not applied. Runtime/environment collectors and Pi extension status data are unavailable in the public CLI context.
- `/workflow` derives checklist display from completed `update_progress` tool messages in the current TUI session's active message list. A reverted/forked branch follows its message list; after compaction removes the original tool input, the TUI does not restore stale checklist data from a separate storage API.
- `/cache-hit-monitor` displays only host-reported cache token counts, `/stamp` summarizes message/tool timing, and `/tui-kit-showcase` exercises enabled/disabled action, busy, selection, input, confirmation, search, and cancellation interactions in the native panel.

## Code references

- [`opencode/extensions/src/index.ts`](../../../../opencode/extensions/src/index.ts) — server plugin implementation.
- [`opencode/extensions/src/tui.ts`](../../../../opencode/extensions/src/tui.ts) and [`opencode/extensions/tui.js`](../../../../opencode/extensions/tui.js) — native TUI plugin and local loader forwarder.
- [`opencode/extensions/src/terminal-presentation.ts`](../../../../opencode/extensions/src/terminal-presentation.ts) and [`opencode/extensions/src/starship-presets.ts`](../../../../opencode/extensions/src/starship-presets.ts) — cell-width renderers, TOML templates, and upstream preset documents.
- [`opencode/extensions/test/plugin.test.mjs`](../../../../opencode/extensions/test/plugin.test.mjs) — session isolation, checklist validation, and Plan permission behavior.
- [`opencode/extensions/test/tui.test.mjs`](../../../../opencode/extensions/test/tui.test.mjs) — slot, cleanup, preset, width, key-interaction, branch-scoped progress, cache summary, and timing fixtures.
- [`opencode/extensions/docs/parity.md`](../../parity.md) — source-by-source port coverage and known API gaps.

## Related

- [OpenCode plugin README](../../README.md)

## Notes

- Goal automatic idle continuation and external wait resumption remain unimplemented because the public server plugin context has no inbox listing; Plan's source shell allowlist/settings/export/fresh-session review are not ported.
- The TUI API has no transcript-row decoration slot. `stamp` is a panel summary, not inline stamps; checklist state cannot be proven after its source tool message disappears.
- Fixture tests and package checks pass. Actual OpenTUI renderer startup is still unverified: Node 24 cannot initialize this package's native FFI, and the OpenCode 2.0.28 PTY smoke could not start its isolated local server because binding port 0 failed in the sandbox. No provider/model request was issued.

## Last updated

2026-10-13
