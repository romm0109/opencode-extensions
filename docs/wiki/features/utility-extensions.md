# Utility extensions
## Summary
The OpenCode v2 port includes server commands/tools for GitHub pull request status, keep-awake lifecycle management, explicit stock quotes, explicit dotenv loading, and Language Server Protocol diagnostics/source fixes. A separate CLI/TUI adapter exposes a native utilities panel and refresh actions. These modules remain isolated until the workflow plugin's server and TUI entrypoints import them.

## Key behavior
- `/github-pr` uses the authenticated `gh` CLI; API output is normalized and credential-like stderr is not exposed.
- Caffeinate starts a platform inhibitor only during active OpenCode execution events; overlapping sessions share one inhibitor, settings persist in plugin storage, and shutdown releases it.
- Ticker quotes are fetched only on explicit command/tool use; the TUI stores symbols and keeps a prior quote marked stale on refresh failure.
- Dotenv loads one explicitly selected file, fills only unset process variables, and reports variable names without values.
- LSP tools use argv-based server settings, bounded JSON-RPC framing and workspace-contained file access; fixes preview unless `write: true` is provided. Server processes are isolated to each tool call rather than kept warm across calls.
- Server and CLI/TUI plugin contexts are distinct. See the integration guide for the required registration calls.

## Code references
- `opencode/extensions/src/utilities/index.ts` — grouped server registrations and cleanup.
- `opencode/extensions/src/utilities/tui.ts` — native panel, keymap commands, storage and event listeners.
- `opencode/extensions/src/utilities/lsp.ts` — JSON-RPC client, LSP routing, diagnostics and code actions.
- `opencode/extensions/src/utilities/caffeinate.ts` — session state machine and platform inhibitor drivers.
- `opencode/extensions/src/utilities/dotenv.ts` — explicit environment loading and value redaction boundary.
- `opencode/extensions/src/utilities/ticker.ts` — symbol checks, Yahoo quote parsing and stale fallback.
- `opencode/extensions/src/utilities/github-pr.ts` — `gh` subprocess and PR summary normalization.
- `opencode/extensions/test/utilities.test.mjs` — fixture, lifecycle, redaction and TUI registration checks.
- `opencode/extensions/docs/utility-ports-integration.md` — integration patch and compatibility notes.

## Related
- [Workflow helpers](workflow-helpers.md)
- [Open questions](../open-questions.md)

## Notes
- No live GitHub or Yahoo requests and no OS inhibitor process are started by the tests.
- A process-local plugin options config supplies custom LSP server commands; this port does not reuse Pi's persistent server pool or status-line widget.

## Last updated
2026-10-13
