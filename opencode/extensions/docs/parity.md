# Pi extension parity ledger

Inventory source: the 34 active entries in the upstream root `package.json` `pi.extensions` array at upstream commit `30ec29b06e3e09a205076683fcec4fdac39c504e`. The separately packaged `pi-tui-kit` library is included below because it supports those entries. The 18 directories under upstream `deprecated/` are historical reference, not active port commitments.

“Candidate” means the host API appears suitable; it does not mean a port exists or has passed a host test. UI, authentication, networking, model calls, and session semantics need feature-level verification.

| Pi source | Intended OpenCode mapping | Current state / gap |
| --- | --- | --- |
| `pi-accounts` | Integration credentials and account selection | Not ported. Credential activation is not session-scoped, so named per-session credential switching cannot be matched safely. |
| `pi-analytics` | Server event stream, plugin storage, command | Partial: `/analytics` projects selected public events to content-free aggregates. No settings or remote export. |
| `pi-btw` | Command plus transient generation or child session | Partial: `/btw` starts isolated child sessions and explicit bring-back appends a synthetic transcript message. No editor cursor insertion. |
| `pi-cache-hit-monitor` | Assistant token data and TUI panel | Partial: `/cache-hit-monitor` reports cache ratio from server-reported tokens. No warning thresholds or estimated savings. |
| `pi-caffeinate` | Lifecycle events plus OS sleep inhibitor | Not ported. Requires an OS-level inhibitor process outside the plugin's safe public API; cross-platform behavior needs a separate design. |
| `pi-chat` | Separate peer-to-peer network process and commands | Not ported. Independent feature, but requires networking, identity and consent-safe tests. |
| `pi-codex-compact` | `session.hook("compaction")` plus Responses provider protocol | Not ported. Hook can inject `summary`, `providerState`, `metadata`, and `tokens`; opaque Codex checkpoint lineage, auth, endpoint and recovery are unverified, so summary-only is not equivalent. |
| `pi-context-management` | Context hook and native compaction hook | Not ported. Must prove exact history/branch semantics and avoid interfering with native compaction or other plugins. |
| `pi-dotenv` | CLI launch environment or server initialization | Not ported. Plugin setup is too late for reliable provider credential discovery; it must not mutate global process environment. |
| `pi-file-context` | Bounded project file read command | Partial: `/file-context <path> [start:end]` enforces project containment and bounded reads. No prompt cursor insertion or Git provenance. |
| `pi-fleet` | Server session APIs, persistent PTY and TUI integration | Partial: `/fleet` tracks child-session jobs and `/fleet-open` opens a native child tab; transport detection is guarded. Launching a separate terminal process remains disabled because v2.0.28 exposes no verified CLI spawn/session-attach contract. |
| `pi-github-pr` | GitHub integration/client and VCS APIs | Not ported. Requires auth reuse, current branch resolution, check/review/comment aggregation and fixtures. |
| `pi-goal` | Session storage, context/generate/permission hooks, commands and server events | Partial: start/edit/pause/resume/status/clear, goal-ID-guarded complete/block/wait, observed response tracking, generation output capped to remaining token budget, and tool denial after observed budget/response exhaustion. Prompt input tokens are reported only after each response, so a response's input may exceed the total budget. Clear interrupts current generation and delayed usage events are tied to the generation that started them. Manual assistant responses can contribute to observed counts. A stored wait deadline does not wake an idle session; no automatic continuation, no-progress review, or management UI. |
| `pi-herdr` | Skills/instructions and lifecycle guidance | Partial: opt-in local read-only `agent.list` discovery when explicit environment variables are set. No agent state reporting, pane/input control, account switching, or orchestration. |
| `pi-inspect` | Public session/client APIs plus local read-only viewer | Not ported. Need prove complete context and live tool activity are available without private APIs. |
| `pi-typesafe-search` | File search and external Jev reranking service | Not ported. SQLite FTS5 may be local; Jev adapter needs fixture-based protocol tests and no paid calls. |
| `pi-langfuse` | OpenTelemetry/event hooks plus Langfuse client | Not ported. Trace fidelity and sensitive-field filtering are unverified. |
| `pi-lsp` | Custom server tools with LSP processes | Not ported. Language discovery, process lifecycle, diagnostics/actions and executable acquisition need fixture and permission tests. |
| `pi-notes` | Commands/tools and storage | Partial: bounded local notes CRUD and `/notes` listing. Notes are plugin records, not Markdown files; no embedded-agent workflow. |
| `pi-plan-mode` | Built-in Plan agent, permission hook, commands | Partial: fail-closed read-only tool/action allowlist, finalization prompt, plan completion, explicit approve/implement handoff, and previous-agent restoration on exit. No automatic finalization retry or settings/export/fresh-session review UI. |
| `pi-recall` | Commands, session storage | Partial: save/search/quote/delete tools. No message picker, editor cursor insertion, or confirmation UI. |
| `pi-stamp` | Event data and TUI panel | Partial: `/stamp` summarizes available response timings/tool counts. No inline row decoration; v2 has no public decoration slot. |
| `pi-starship` | CLI/TUI status rendering | Not ported. Starship requires a shell subprocess; no prompt-aware subprocess API was verified in the v2 CLI plugin. |
| `pi-statusline` | CLI/TUI status rendering | Partial: footer shows session status/title/model/cost/tokens. Presets, extension state, and layout settings remain missing. |
| `pi-subagents` | Session API, bounded child sessions and messaging | Partial: bounded child sessions, addressed parent requests, parent responses, wait/cancel, and parent-delete cleanup. Broker requests do not survive plugin reload; children inherit host permissions and have no per-child tool allowlist. |
| `pi-sync` | CLI command with Git, WebDAV, R2 and S3 transports | Not ported. Must define OpenCode allowlist/config/session formats and safe conflict handling per transport. |
| `pi-ticker` | CLI/TUI widget plus quote fetcher | Not ported. Quote fetching adds network activity; provider, staleness, failure, and configuration semantics need a transparent design. |
| `pi-progress` | Canonical tool plus TUI panel | Partial: bounded checklist tool rejects invalid input and the branch-aware `/workflow` panel accepts only successful tool results from current messages. Compacted-away tool input cannot be restored; no dismiss/completion toast or adaptive widget. |
| `pi-tool` | Command inspecting `ctx.tool.list()` | Partial: `/tool` lists and inspects public registered schemas. Does not change tool availability or show prompt source. |
| `pi-tui-kit-showcase` | Private CLI/TUI test/demo | Partial: `/tui-kit-showcase` demonstrates native v2 slots and panels, not Pi custom widgets/editor controls. |
| `pi-typesafe` | Typed Jev integration command/tool | Not ported. Requires protocol validation and explicit external service configuration; no paid/fallback calls in tests. |
| `pi-typesafe-compact` | Jev selection plus native compaction flow | Not ported. Selection, transcript boundaries and compaction behavior need fixture tests. |
| `pi-usage` | Provider credential/usage APIs and CLI command | Not ported. OpenCode has no unified public quota API for source providers. No credential scraping or reset purchases are included. |
| `pi-worktree` | Native `ctx.worktree` API and command | Partial: `/worktree list|add|remove`, with non-force removal. No session carryover, confirm manager, or prune behavior. |
| `pi-tui-kit` library | Reusable OpenCode CLI/TUI helpers | Partial: native TUI slots/panels are used directly by this port; no general helper library or Pi component compatibility layer. |

## Cross-cutting API limits verified so far

- OpenCode server and CLI/TUI plugin APIs are distinct in v2.0.28; changing the terminal interface requires a CLI plugin, not the V1 `@opencode-ai/plugin` hook model.
- The public server session client has session create/get/prompt/generate/command/compact/synthetic/wait APIs, but Pi's session-tree/message-store APIs cannot be assumed.
- No public transcript message/tool-row decoration or editor getter/setter/insertion API has been verified. The `tui.prompt.append` event name alone does not prove a public emitter.
- The session compaction hook can skip a model request with a custom summary result, but this proves only the hook shape, not compatibility with opaque Codex checkpoint state.
- OpenCode's plugin Effect runtime must be shared with the host; downstream bundles must externalize `effect` and its public subpaths.
