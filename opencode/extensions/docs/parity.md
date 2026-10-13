# Pi extension parity ledger

Inventory source: the 34 active entries in the upstream root `package.json` `pi.extensions` array at upstream commit `30ec29b06e3e09a205076683fcec4fdac39c504e`. The separately packaged `pi-tui-kit` library is included below because it supports those entries. The 18 directories under upstream `deprecated/` are historical reference, not active port commitments.

“Candidate” means the host API appears suitable; it does not mean a port exists or has passed a host test. UI, authentication, networking, model calls, and session semantics need feature-level verification.

| Pi source | Intended OpenCode mapping | Current state / gap |
| --- | --- | --- |
| `pi-accounts` | Integration credentials and account selection | Not ported. Credential activation is not session-scoped, so named per-session credential switching cannot be matched safely. |
| `pi-analytics` | Server event stream, plugin storage, command | Partial: `/analytics` projects selected public events to content-free aggregates. No settings or remote export. |
| `pi-btw` | Command plus transient generation or child session | Not ported. The Pi editor-preserving side pane and answer bring-back lack a verified public editor API. |
| `pi-cache-hit-monitor` | Assistant token data and TUI panel | Partial: `/cache-hit-monitor` reports cache ratio from server-reported tokens. No warning thresholds or estimated savings. |
| `pi-caffeinate` | Lifecycle events plus OS sleep inhibitor | Not ported. Requires an OS-level inhibitor process outside the plugin's safe public API; cross-platform behavior needs a separate design. |
| `pi-chat` | Separate peer-to-peer network process and commands | Not ported. Independent feature, but requires networking, identity and consent-safe tests. |
| `pi-codex-compact` | `session.hook("compaction")` plus Responses provider protocol | Not ported. Hook can inject `summary`, `providerState`, `metadata`, and `tokens`; opaque Codex checkpoint lineage, auth, endpoint and recovery are unverified, so summary-only is not equivalent. |
| `pi-context-management` | Context hook and native compaction hook | Not ported. Must prove exact history/branch semantics and avoid interfering with native compaction or other plugins. |
| `pi-dotenv` | CLI launch environment or server initialization | Not ported. Plugin setup is too late for reliable provider credential discovery; it must not mutate global process environment. |
| `pi-file-context` | Bounded project file read command | Partial: `/file-context <path> [start:end]` enforces project containment and bounded reads. No prompt cursor insertion or Git provenance. |
| `pi-fleet` | Server session APIs, persistent PTY and TUI integration | Not ported. Need verify APIs for creating/connecting bounded side sessions and split terminal behavior. |
| `pi-github-pr` | GitHub integration/client and VCS APIs | Not ported. Requires auth reuse, current branch resolution, check/review/comment aggregation and fixtures. |
| `pi-goal` | Session storage, context hook, commands and server events | Partial: start/edit/pause/resume/status/clear, goal-ID-guarded complete/block/wait, observed response tracking, and optional token budget. Limits are guidance/state tracking, not a hard host-enforced stop. Manual assistant responses can contribute to the observed count. No automatic idle continuation, external wait wakeup, no-progress review, or management UI. |
| `pi-herdr` | Skills/instructions and lifecycle guidance | Not ported. Herdr protocol and cross-agent terminal orchestration need separate security review and scenario tests. |
| `pi-inspect` | Public session/client APIs plus local read-only viewer | Not ported. Need prove complete context and live tool activity are available without private APIs. |
| `pi-typesafe-search` | File search and external Jev reranking service | Not ported. SQLite FTS5 may be local; Jev adapter needs fixture-based protocol tests and no paid calls. |
| `pi-langfuse` | OpenTelemetry/event hooks plus Langfuse client | Not ported. Trace fidelity and sensitive-field filtering are unverified. |
| `pi-lsp` | Custom server tools with LSP processes | Not ported. Language discovery, process lifecycle, diagnostics/actions and executable acquisition need fixture and permission tests. |
| `pi-notes` | Commands/tools and storage | Partial: bounded local notes CRUD and `/notes` listing. Notes are plugin records, not Markdown files; no embedded-agent workflow. |
| `pi-plan-mode` | Built-in Plan agent, permission hook, commands | Partial: read-only mutation filtering/denial, plan completion, and explicit approve/implement handoff. No source allowlist/shell policy/settings/export/fresh-session review UI. |
| `pi-recall` | Commands, session storage | Partial: save/search/quote/delete tools. No message picker, editor cursor insertion, or confirmation UI. |
| `pi-stamp` | Event data and TUI panel | Partial: `/stamp` summarizes available response timings/tool counts. Inline row placement remains a hard API gap: v2.0.28 has no public transcript-row decoration slot. |
| `pi-starship` | CLI/TUI status rendering | Partial native footer: all 13 upstream preset TOML documents, TOML format/module/palette parsing, module `format`/`symbol`/`style`/`disabled` overrides, ANSI palette colors, and cell-width fitting are carried into the CLI plugin. Other module options parse but are ignored. It uses host session/model/token/cost/VCS data without launching Starship or a shell. Pi-specific extension states and many environment/runtime collectors have no corresponding public TUI data source and render empty; command/configuration menus and asynchronous refresh modules are not ported. |
| `pi-statusline` | CLI/TUI status rendering | Partial native footer: mutually exclusive statusline/Starship/off prompt-footer replacement, persistent mode selection, and minimal/balanced/verbose profiles use host-reported session/model/cost/token/VCS fields. Pi's full segment/icon catalog, extension-status registry, custom information profiles, and periodic collection lifecycle are not available in the public TUI context. |
| `pi-subagents` | Session API, bounded child sessions and messaging | Not ported. Public server `ctx.session` does not expose all Pi session controls; do not imply parity until child ownership and messaging are tested. |
| `pi-sync` | CLI command with Git, WebDAV, R2 and S3 transports | Not ported. Must define OpenCode allowlist/config/session formats and safe conflict handling per transport. |
| `pi-ticker` | CLI/TUI widget plus quote fetcher | Not ported. Quote fetching adds network activity; provider, staleness, failure, and configuration semantics need a transparent design. |
| `pi-progress` | Canonical tool plus TUI panel | Partial: bounded checklist tool and branch-aware `/workflow` panel rebuilt from current messages. Compacted-away tool input cannot be restored; no dismiss/completion toast or adaptive widget. |
| `pi-tool` | Command inspecting `ctx.tool.list()` | Partial: `/tool` lists and inspects public registered schemas. Does not change tool availability or show prompt source. |
| `pi-tui-kit-showcase` | Private CLI/TUI test/demo | Partial native panel: `/tui-kit-showcase` supports keyboard-driven enabled/disabled action, busy, selection, input, confirm, search, and cancel examples. Pi custom component/theme/keybinding library contracts are not portable as-is. |
| `pi-typesafe` | Typed Jev integration command/tool | Not ported. Requires protocol validation and explicit external service configuration; no paid/fallback calls in tests. |
| `pi-typesafe-compact` | Jev selection plus native compaction flow | Not ported. Selection, transcript boundaries and compaction behavior need fixture tests. |
| `pi-usage` | Provider credential/usage APIs and CLI command | Not ported. OpenCode has no unified public quota API for source providers. No credential scraping or reset purchases are included. |
| `pi-worktree` | Native `ctx.worktree` API and command | Partial: `/worktree list|add|remove`, with non-force removal. No session carryover, confirm manager, or prune behavior. |
| `pi-tui-kit` library | Reusable OpenCode CLI/TUI helpers | Partial: native TUI slots/panels are used directly by this port; no general helper library or Pi component compatibility layer. |

## Cross-cutting API limits verified so far

- OpenCode server and CLI/TUI plugin APIs are distinct in v2.0.28; changing the terminal interface requires a CLI plugin, not the V1 `@opencode-ai/plugin` hook model.
- The public server session client has session create/get/prompt/generate/command/compact/synthetic/wait APIs, but Pi's session-tree/message-store APIs cannot be assumed.
- No public transcript message/tool-row decoration or editor getter/setter/insertion API has been verified. The `tui.prompt.append` event name alone does not prove a public emitter. The v2.0.28 TUI package does expose `prompt.footer` replacement, `session.panel`, and focused panel keyboard events; the port uses those exact declared slots.
- The session compaction hook can skip a model request with a custom summary result, but this proves only the hook shape, not compatibility with opaque Codex checkpoint state.
- OpenCode's plugin Effect runtime must be shared with the host; downstream bundles must externalize `effect` and its public subpaths.
