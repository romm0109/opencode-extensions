# Workflow helpers

## Summary

The OpenCode v2 plugin provides session-scoped goal guidance, an advisory planning toggle, and a checklist tool. This is the first native server-plugin port from the upstream Pi extension collection.

## Key behavior

- `/goal` sets, inspects, or clears a goal stored under a session-specific key.
- `/plan` adds or removes read-only planning guidance in later context; it does not enforce permissions or switch agents.
- `update_progress` stores a validated checklist for the current session and adds it to later context.
- All persistent state uses the OpenCode plugin storage API; no external model or service is called.

## Code references

- [`opencode/extensions/src/index.ts`](../../../../opencode/extensions/src/index.ts) — server plugin implementation.
- [`opencode/extensions/test/plugin.test.mjs`](../../../../opencode/extensions/test/plugin.test.mjs) — storage isolation, checklist validation, and advisory plan coverage.
- [`opencode/extensions/docs/parity.md`](../../parity.md) — source-by-source port coverage and known API gaps.

## Related

- [OpenCode plugin README](../../README.md)

## Notes

- These are workflow hints, not automation or permission enforcement. The full Pi goal loop and native Plan-agent switching remain unimplemented.

## Last updated

2026-10-13
