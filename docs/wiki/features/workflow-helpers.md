# Workflow helpers

## Summary

The OpenCode v2 package provides session-scoped Goal and Plan workflows, local notes and recall tools, file-context and worktree commands, content-free analytics, and a separate CLI/TUI plugin for footer status and session panels. It is a partial native port from the upstream Pi extension collection; the source-by-source ledger identifies the coverage boundary.

## Key behavior

- `/goal` starts, edits, pauses, resumes, inspects, and clears a session goal; completion/block/wait tools are ID-guarded. Generation output is capped to remaining budget, and exhausted goals interrupt generation and deny tools. Input tokens are known only after each response, so total usage can exceed the configured budget by that response's input.
- `/plan <task>` switches to the Plan agent, enforces a fail-closed read-only tool/action allowlist while planning and awaiting approval, saves a completed plan for review, and requires explicit approval and implementation handoff. Exiting restores the previous agent.
- `update_progress` rejects invalid checklist snapshots as tool errors; `/workflow` reconstructs only accepted updates from the active branch transcript rather than a divergent storage snapshot.
- `/notes`, `/recall`, `/file-context`, `/tool`, `/worktree`, and `/analytics` expose the current local server-port surface. Goal/Plan starts and resumes may submit model prompts; informational commands do not.
- The CLI/TUI plugin uses v2 `prompt.footer.status`, `home.footer.status`, `session.panel`, and keymap slash commands; it must be configured separately in `cli.json`.
- `/workflow` derives checklist display from completed `update_progress` tool messages in the current TUI session's active message list. A reverted/forked branch follows its message list; after compaction removes the original tool input, the TUI does not restore stale checklist data from a separate storage API.
- `/cache-hit-monitor` displays only host-reported cache token counts, `/stamp` summarizes message/tool timing, and `/tui-kit-showcase` demonstrates native slots and panels.

## Code references

- [`opencode/extensions/src/index.ts`](../../../../opencode/extensions/src/index.ts) — server plugin implementation.
- [`opencode/extensions/src/tui.ts`](../../../../opencode/extensions/src/tui.ts) and [`opencode/extensions/tui.js`](../../../../opencode/extensions/tui.js) — native TUI plugin and local loader forwarder.
- [`opencode/extensions/test/plugin.test.mjs`](../../../../opencode/extensions/test/plugin.test.mjs) — session isolation, checklist validation, and Plan allowlist/permission behavior.
- [`opencode/extensions/test/goal-plugin.test.mjs`](../../../../opencode/extensions/test/goal-plugin.test.mjs) — goal lifecycle, response budget enforcement, and tool gating.
- [`opencode/extensions/test/tui.test.mjs`](../../../../opencode/extensions/test/tui.test.mjs) — slot, panel, branch-scoped progress, cache summary, and timing fixtures.
- [`opencode/extensions/docs/parity.md`](../../parity.md) — source-by-source port coverage and known API gaps.

## Related

- [OpenCode plugin README](../../README.md)

## Notes

- Goal automatic idle continuation and external wait resumption remain unimplemented because the public server plugin context has no inbox listing; Plan's source shell allowlist/settings/export/fresh-session review are not ported.
- The TUI API has no transcript-row decoration slot. `stamp` is a panel summary, not inline stamps; checklist state cannot be proven after its source tool message disappears.
- Package typecheck and 25 tests pass; pinned Biome checks pass. The TUI package was previously installed in a clean prefix and loaded in OpenCode 2.0.28 without setup errors; rerun the host smoke test after the current edits.

## Last updated

2026-10-13
