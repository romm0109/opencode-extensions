# Pi extension parity ledger

Inventory source: the 34 active entries in the upstream root `package.json` `pi.extensions` array at upstream commit `30ec29b06e3e09a205076683fcec4fdac39c504e`. The separately packaged `pi-tui-kit` library is included below because it supports those entries. The 18 directories under upstream `deprecated/` are historical reference, not active port commitments.

“Candidate” means the host API appears suitable; it does not mean a port exists or has passed a host test. UI, authentication, networking, model calls, and session semantics need feature-level verification.

| Pi source | Intended OpenCode mapping | Current state / gap |
| --- | --- | --- |
| `pi-accounts` | Integration credentials and account selection | Not ported. OpenCode credential activation is not yet shown to be session-scoped; switching credentials globally would not preserve Pi behavior. |
| `pi-analytics` | Server event stream, tool hooks, plugin storage, commands | Not ported. Need verify event coverage and preserve the source's content-free metric policy. |
| `pi-btw` | Command plus transient generation or child session | Not ported. The Pi editor-preserving side pane and answer bring-back lack a verified public editor API. |
| `pi-cache-hit-monitor` | Request/tool events and TUI status slot | Not ported. Token/cache metadata coverage and usable TUI placement need validation. |
| `pi-caffeinate` | Lifecycle status events plus OS sleep inhibitor | Not ported. Host lifecycle/idle signals and cross-platform inhibitor behavior need isolated tests. |
| `pi-chat` | Separate peer-to-peer network process and commands | Not ported. Independent feature, but requires networking, identity and consent-safe tests. |
| `pi-codex-compact` | `session.hook("compaction")` plus Responses provider protocol | Not ported. Hook can inject `summary`, `providerState`, `metadata`, and `tokens`; opaque Codex checkpoint lineage, auth, endpoint and recovery are unverified, so summary-only is not equivalent. |
| `pi-context-management` | Context hook and native compaction hook | Not ported. Must prove exact history/branch semantics and avoid interfering with native compaction or other plugins. |
| `pi-dotenv` | CLI launch environment or server initialization | Not ported. Plugin setup occurs too late to promise Pi's early provider-credential discovery. |
| `pi-file-context` | File tools or command with URI attachments | Not ported. OpenCode exposes file APIs, but editor insertion/selection and immutable Git provenance require a verified user flow. |
| `pi-fleet` | Server session APIs, persistent PTY and TUI integration | Not ported. Need verify APIs for creating/connecting bounded side sessions and split terminal behavior. |
| `pi-github-pr` | GitHub integration/client and VCS APIs | Not ported. Requires auth reuse, current branch resolution, check/review/comment aggregation and fixtures. |
| `pi-goal` | Session-scoped storage, context hook, commands, status/inbox events | Partial: `/goal`, context guidance, and `update_progress` are implemented. No automatic continuation, queue, wait protocol, exact idle-gated retries, token accounting, or completion lifecycle. |
| `pi-herdr` | Lifecycle events plus included skill/instructions | Not ported. Herdr protocol and safe terminal-orchestration guidance need separate validation. |
| `pi-inspect` | Public session/client APIs plus local read-only viewer | Not ported. Need prove complete context and live tool activity are available without private APIs. |
| `pi-typesafe-search` | File search and external Jev reranking service | Not ported. SQLite FTS5 may be local; Jev adapter needs fixture-based protocol tests and no paid calls. |
| `pi-langfuse` | OpenTelemetry/event hooks plus Langfuse client | Not ported. Trace fidelity and sensitive-field filtering are unverified. |
| `pi-lsp` | Custom server tools with LSP processes | Not ported. Can be native tools, but language discovery, process lifecycle and diagnostics/actions need full port/tests. |
| `pi-notes` | Commands/tools and isolated embedded-agent session | Not ported. OpenCode server API lacks Pi's exact embedded-agent workspace flow; safety boundary needs redesign. |
| `pi-plan-mode` | Built-in Plan agent or permission rules and commands | Partial: `/plan` adds advisory context only. It does not enforce read-only access or switch agents, so it is explicitly not equivalent yet. |
| `pi-recall` | Commands, session APIs, storage | Not ported. Saving/quoting across sessions is plausible; exact selection UI and insertion route are unverified. |
| `pi-stamp` | Event capture and custom TUI component | Not ported. No verified transcript-row decoration slot; a panel/status alternative would be a visible behavior change. |
| `pi-starship` | CLI/TUI status rendering | Not ported. Starship module semantics and the required terminal extension surface need a dedicated CLI plugin. |
| `pi-statusline` | CLI/TUI status rendering | Not ported. Context/cost fields, presets, extension state, and layout need CLI plugin validation. |
| `pi-subagents` | Session API, bounded child sessions and messaging | Not ported. Public server `ctx.session` does not expose all Pi session controls; do not imply parity until child ownership and messaging are tested. |
| `pi-sync` | CLI command with Git, WebDAV, R2 and S3 transports | Not ported. Must define OpenCode allowlist/config/session formats and safe conflict handling per transport. |
| `pi-ticker` | CLI/TUI widget plus quote fetcher | Not ported. TUI placement, market data failures, staleness and network behavior need implementation. |
| `pi-progress` | Custom tool, session storage and context hook | Partial: `update_progress` stores a per-session checklist and adds it to later context. No persistent branch reconciliation, restored compaction boundary, widget, or completion summary. |
| `pi-tool` | Command inspecting `ctx.tool.list()` | Not ported. The public tool registry can expose effective tool metadata, but prompt-guideline/source detail availability needs verification. |
| `pi-tui-kit-showcase` | Private CLI/TUI plugin test/demo | Not ported. It is active in the Pi root manifest but explicitly source-only and private; map as a development showcase, not a user feature. |
| `pi-typesafe` | Typed Jev integration command/tool | Not ported. Requires protocol validation and explicit external service configuration; no paid/fallback calls in tests. |
| `pi-typesafe-compact` | Jev selection plus native compaction flow | Not ported. Selection, transcript boundaries and compaction behavior need fixture tests. |
| `pi-usage` | Provider credential/usage APIs and CLI command | Not ported. OpenCode doesn't expose every source provider's quota API through a single equivalent; `/fast` and reset redemption are not covered. |
| `pi-worktree` | Native `ctx.worktree` API and commands | Not ported. OpenCode has project-scoped create/list/remove/refresh operations; matching Pi branch, session carryover, confirm and prune semantics still needs implementation. |
| `pi-tui-kit` library | Reusable OpenCode CLI/TUI helpers | Not ported. OpenCode has distinct CLI-plugin interfaces; no Pi TUI components should be reused as if compatible. |

## Cross-cutting API limits verified so far

- OpenCode server and CLI/TUI plugin APIs are distinct in v2.0.28; changing the terminal interface requires a CLI plugin, not the V1 `@opencode-ai/plugin` hook model.
- The public server session client has session create/get/prompt/generate/command/compact/synthetic/wait APIs, but Pi's session-tree/message-store APIs cannot be assumed.
- No public transcript message/tool-row decoration or editor getter/setter/insertion API has been verified. The `tui.prompt.append` event name alone does not prove a public emitter.
- The session compaction hook can skip a model request with a custom summary result, but this proves only the hook shape, not compatibility with opaque Codex checkpoint state.
- OpenCode's plugin Effect runtime must be shared with the host; downstream bundles must externalize `effect` and its public subpaths.
