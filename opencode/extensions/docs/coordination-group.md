# Session coordination group

This port adds server-plugin modules for side questions (`/btw`), child-session jobs (`subagent_*` and `/subagents`), Fleet-style job management (`/fleet`), and opt-in read-only Herdr status (`herdr_agents`, `/herdr`). Source concepts and expected behavior are adapted from the MIT-licensed [`narumiruna/pi-extensions`](https://github.com/narumiruna/pi-extensions) project, audited at commit `30ec29b06e3e09a205076683fcec4fdac39c504e`; the OpenCode implementation uses only the published OpenCode 2.0.28 interfaces.

## Registration

The shared server entrypoint should import `registerCoordinationGroup` from `./coordination/index.ts`, await it during plugin setup, and return its cleanup callback alongside existing cleanup. This registers the four server-side command/tool groups and an event observer that interrupts/removes child sessions when their owning parent session is deleted. The function itself does not alter shared plugin registration.

The shared TUI entrypoint should compose `createCoordinationTui()` from `./coordination/tui.ts` with its existing TUI setup. It adds a native child-session panel, `/fleet-open <session-id>` for opening a child in a host tab, and `/btw-bring <session-id>` for explicit answer bring-back. The main package's plugin declaration remains the owner of loading that TUI module.

## Behavior and boundaries

- Each job is a host-created child session linked to its parent. Job metadata is persisted per parent; the transcript stays in the child session. Child sessions inherit the parent's agent and host permission behavior; the public session API exposes no per-child tool allowlist.
- `subagent_spawn` returns after the host accepts the child prompt. `subagent_wait` waits for the session to settle; tool-call cancellation cancels only that wait. `subagent_cancel` interrupts the child. A parent deletion cleans up its child sessions; plugin unload interrupts active jobs but preserves their transcripts.
- Child `subagent_send` creates an addressed request in the parent transcript. The parent answers with `subagent_respond`; the child collects it with `subagent_wait`. A wait accepts an optional timeout in seconds; stopping a wait leaves the job or unanswered request active. The in-memory request/response broker does not survive plugin reload, although the session transcripts and job list do.
- `/btw` creates an isolated child session without copying the parent transcript. OpenCode v2.0.28 publishes no prompt-editor insertion API, so bring-back is a user-invoked synthetic transcript message (`/btw bring <job-id>` or `/btw-bring <session-id>`), not cursor insertion.
- `/fleet` creates and manages the same host-owned child-session jobs. It reports guarded tmux, Zellij, or Ghostty environment markers. Launching a new OpenCode terminal process remains disabled: the 2.0.28 extension/client declarations expose no CLI spawn/session-attach contract, and the local CLI help could not be inspected because the binary attempted to write its user-global log outside the workspace. Do not substitute a bare child session for Pi Fleet's terminal process or invent `opencode --session` flags. Upstream's tmux/Zellij/Ghostty launch paths remain the reference for a future adapter once the CLI contract and native permissions are verified.
- Herdr access is disabled unless `HERDR_ENV=1` and an absolute local `HERDR_SOCKET_PATH` are explicitly supplied by the OpenCode launcher. The only operation is `agent.list`; it never reports OpenCode session state to Herdr, starts/closes panes, sends input, or changes accounts. The implementation does not connect during plugin setup.

## Verification

`npm run typecheck` and `npm test` cover registration modules, session isolation, child request-response, cancellation, parent cleanup, concurrent job creation, bounded Herdr parsing, local-endpoint validation, and guarded transport detection. Tests use scripted sessions and do not call a model provider, Herdr process, or terminal launcher. No OpenCode host/TUI integration smoke was run; the CLI help attempt failed at startup while opening its user-global log outside the task workspace.
