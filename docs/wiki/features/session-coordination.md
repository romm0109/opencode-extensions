# Session coordination

## Summary

The coordination group ports side questions, subagent jobs, Fleet-style session management, and Herdr observation to OpenCode v2.0.28 public server and TUI APIs. Jobs use host-created child sessions linked to a parent; transcripts stay in those sessions, while only explicitly brought-back answers enter the parent transcript.

## Key behavior

- `subagent_spawn` creates a child session with the parent's agent and host permission behavior, starts its task, and returns a job ID. The public plugin API has no per-child tool allowlist.
- Parent/child messages use addressed request-response tools. Wait cancellation stops the wait, not the job or request. Session deletion removes owned child sessions; plugin unload interrupts active jobs and preserves their transcripts.
- `/btw` does not copy the parent transcript. OpenCode has no public prompt-editor insertion API, so bring-back uses a user-invoked synthetic transcript message.
- `/fleet` manages host child sessions and detects guarded tmux/Zellij/Ghostty environment markers. Terminal process launch remains disabled until a supported OpenCode CLI session-attachment contract is verified.
- Herdr access is opt-in via launcher-provided `HERDR_ENV=1` and `HERDR_SOCKET_PATH`; only local `agent.list` observation is exposed. The plugin does not connect during setup or report OpenCode state to Herdr.

## Code references

- [`coordination.ts`](../../../opencode/extensions/src/coordination/coordination.ts) — session-job ownership, persistence, messaging, cancellation, and cleanup.
- [`index.ts`](../../../opencode/extensions/src/coordination/index.ts) — server registration and session-deletion lifecycle observer.
- [`tui.ts`](../../../opencode/extensions/src/coordination/tui.ts) — child-session panel, tab opening, and explicit side-answer bring-back.
- [`coordination-group.md`](../../../opencode/extensions/docs/coordination-group.md) — integration instructions and host/API limitations.
- [`coordination.test.mjs`](../../../opencode/extensions/test/coordination/coordination.test.mjs) and [`registration.test.mjs`](../../../opencode/extensions/test/coordination/registration.test.mjs) — scripted lifecycle and TUI registration behavior.

## Related

- [Open questions](../open-questions.md)
- [OpenCode plugin README](../../../opencode/extensions/README.md)

## Notes

- The server and TUI module exports still need to be composed into the shared package entrypoints by the main integration owner.
- Child request-response state is in memory and does not survive plugin reload. Child sessions and job metadata do.
- No actual OpenCode host/TUI smoke, model-provider call, terminal launcher, or live Herdr request was run.

## Last updated

2026-10-13
