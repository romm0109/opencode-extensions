# Provider and context modules

These modules are an isolated server-plugin group for the provider/context part of the upstream Pi conversion at `30ec29b06e3e09a205076683fcec4fdac39c504e`. They are intentionally not called from the main plugin registry or the CLI/TUI entrypoint on this branch. The only additional runtime requirement is Node's built-in `node:sqlite` with FTS5 (the project targets Node 24); there are no new npm dependencies.

## Features and boundaries

- `provider-accounts` lists sanitized provider IDs, names, and activation state. It never activates a credential. OpenCode 2.0.28's plugin `Context.credential` is typed as `Pick<CredentialApi, "activate">`; that operation requires a global `credentialID`, while the plugin context exposes no list and no session scope. Per-session account switching is therefore blocked by the public API.
- `provider-usage` stores a bounded, deduplicated projection of host `session.step.ended` token and cost values. It reports local usage totals only. It does not query provider quotas, balances, windows, resets, or spend caps; the plugin context provides no credential-read API and there is no unified provider quota API.
- `typesafe_question` validates Jev request and response semantics, calls the fixed official TypeSafe endpoint when `typesafeApiKey` is present, and supports the source's explicit fallback only when `openRouterFallback: true` and a separate `openRouterApiKey` are configured. TypeSafe wins when both keys exist; a failed request never switches services. Both routes bound request/response payloads and model-visible output, honor the tool `AbortSignal`, and suppress credential/response-body text from errors.
- `typesafe_search` builds a throwaway in-memory FTS5 index from bounded project-local text files and returns exact source ranges. Lexical search is the default and requires no credential. `semantic_rerank: true` explicitly sends candidate excerpts to the fixed TypeSafe endpoint and requires `typesafeApiKey`; a failed request errors instead of silently changing services.
- `/context-management enable|disable|status|rollover` stores opt-in state per OpenCode session ID. Rollover invokes the host's native `session.compact()` operation; this module does not prune messages, inject summaries, or infer fork ancestry. This is a safe manual fallback, not Pi's summary-free context window. OpenCode exposes a context hook but no verified branch-entry tree or durable compaction-suffix fingerprints, so hiding exact old history, branch-local recall, and notes cannot be implemented lineage-safely. A fork starts disabled unless enabled separately.
- The Codex checkpoint provenance gate models provider, exact model, stable account fingerprint, endpoint origin, protocol, checkpoint ID, and opaque provider state. A checkpoint is replay-compatible only when every identity matches. OpenCode 2.0.28 exposes provider state as an unknown-key map but does not expose active account identity or resolved provider endpoint in the compaction hook, so the gate cannot be populated truthfully by the plugin. `/codex-compact` documents this boundary; custom replay stays disabled.
- The selective compaction core accepts injected Jev evaluation and summarization callbacks, validates per-message selection, preserves rejected plain-text units as labeled data, bounds transcript size, and honors cancellation. The OpenCode compaction hook has no `AbortSignal`; the adapter is deliberately not registered because a billed evaluator call cannot be canceled on user interrupt. `/typesafe-compact` reports this blocker and native compaction remains active.

The options keys are read only when their corresponding tools are invoked. No TypeSafe or OpenRouter key is set, requested, copied, or validated by these tests. Semantic features have not been live-tested and can incur provider charges when a user later configures and invokes them.

## Integration patch for the owner

No root registry, package manifest, dependency list, or root extension entrypoint was changed. To register the group from `src/feature-modules.ts`, apply this patch after reviewing command-name collisions:

```diff
 import type { PluginContext } from "./plugin-types.ts"
 import { registerFileContext } from "./file-context.ts"
 import { registerToolCatalog } from "./tool-catalog.ts"
 import { registerWorktreeCommands } from "./worktree.ts"
+import { registerProviderContextExtensions } from "./provider-context/index.ts"

 /** Register file-context quoting, tool catalog inspection, and native worktree commands. */
-export async function registerAdditionalExtensions(context: PluginContext): Promise<void> {
+export async function registerAdditionalExtensions(context: PluginContext): Promise<() => Promise<void>> {
   await Promise.all([registerFileContext(context), registerToolCatalog(context), registerWorktreeCommands(context)])
+  return registerProviderContextExtensions(context)
 }
```

Then propagate cleanup from `src/index.ts`:

```diff
-    await registerAdditionalExtensions(ctx)
+    const cleanupAdditional = await registerAdditionalExtensions(ctx)
     await ctx.tool.transform(...)
-    return () => { cleanup(); cleanupAnalytics() }
+    return async () => { await cleanupAdditional(); cleanup(); cleanupAnalytics() }
```

If the current owner branch already changed either setup shape, preserve its cleanup ordering and add the group registration in the equivalent location. There are no package dependency changes. The new commands are `/provider-accounts`, `/provider-usage`, `/context-management`, `/codex-compact`, and `/typesafe-compact`; tools are `typesafe_question` and `typesafe_search`. Keep this group opt-in until those names and any server-side data transfer policies are accepted.

## Verification

Focused scripted tests use synthetic provider IDs, synthetic keys, fake fetch, temporary project files, and local SQLite only. No new service was authenticated and no remote endpoint was contacted.
