# Provider and context modules

## Summary

The optional OpenCode server-plugin group in `opencode/extensions/src/provider-context/` ports selected provider/context behavior from the pinned Pi source while keeping host-owned account, compaction, and session semantics in control. It is exported from its own module but is not registered by the main extension entrypoint on this branch.

## Key behavior

- Provider accounts are read-only because `@opencode/plugin` 2.0.28 exposes global credential activation but no plugin-visible account list or session-scoped activation.
- Usage reporting aggregates bounded host token and cost events; it makes no provider-quota claims.
- TypeSafe tools use semantic validation, fixed-origin requests, an opt-in OpenRouter fallback with no retry-based provider switching, explicit search reranking, and cancellation.
- Search uses a throwaway FTS5 database and returns exact file line ranges without writing the project.
- Context rollover is disabled per session until enabled and then calls native compaction only by explicit command. Summary-free window hiding and branch-local recall/notes remain blocked because the public API does not expose verified branch-entry lineage.
- Codex checkpoint replay and automated TypeSafe compaction remain disabled until their opaque provenance and cancellation requirements can be met through public host APIs.

## Code references

- `opencode/extensions/src/provider-context/index.ts` — isolated registration function and exports.
- `opencode/extensions/src/provider-context/search.ts` — workspace-safe FTS5 indexing and optional Jev ranking.
- `opencode/extensions/src/provider-context/codex-provenance.ts` — exact-match checkpoint replay gate.
- `opencode/extensions/src/provider-context/typesafe-compact.ts` — cancellable selection core, not wired to the native compaction hook.
- `opencode/extensions/test/provider-context.test.mjs` — scripted host, validation, provenance, cancellation, and line-range tests.
- `opencode/extensions/docs/provider-context-modules.md` — API boundaries and exact owner integration patch.

## Related

- [Workflow helpers](workflow-helpers.md)

## Notes

TypeSafe behavior has only been tested with injected fetch and synthetic keys. Provider quota endpoints, account activation, Codex replay, and automatic selective compaction are not live-verified.

## Last updated

2026-10-13
