# Native Goal behavior

Goal now owns a bounded automatic workflow in OpenCode, rather than only adding instructions to a prompt. The source reference is `packages/pi-goal` in the preserved upstream tree; removed queue commands remain rejected.

## Commands and tools

`/goal [--tokens <positive budget>] <objective>` starts a session-local Goal. Budget suffixes `k` and `m` are supported. `/goal edit [--tokens <budget>] <objective>` changes the objective without discarding verified accounting. `/goal pause` stops active or waiting work; `/goal resume` preserves lifetime consumption and resets response/no-progress safety counters. `/goal status` is read-only; `/goal clear` and its `stop` alias clear the state and interrupt current execution. Informational commands never submit a model request. These server commands work through the native CLI and client command API.

The model receives the exact objective and Goal ID. Completion requires a matching current response generation, a completed-result summary, and concrete evidence. Blocking requires at least three Goal responses since the last explicit resume/user input and a reported recurring external impasse; the extension cannot independently prove the truth of the model's evidence.

`goal_wait` accepts `reason` (or the existing `waiting_for` alias) and an optional `resume_after_ms`. The prior `resume_at` absolute-deadline form remains accepted; only one deadline can be supplied. Delays clamp to ten seconds and are bounded by the native timer range. Waiting retains workflow ownership, persists its absolute deadline, and resumes after plugin reload when due. An ordinary external/user prompt clears the wait and invalidates its old wake; use an external wake source when possible, with the deadline as a safety wake rather than frequent polling.

## Budgets, continuation and cancellation

A successful execution is not yet settled idle. Goal waits for native `session.wait`, then rechecks its generation and user-input epoch before submitting one queued continuation. Native retries and compaction remain host-owned. Failed execution does not create a competing retry loop: explicit credit/quota/billing failures become usage-limited; other exhausted errors stop blocked for review. Pause, clear, edit, new input, replacement and unload invalidate pending continuation work. Rejected prompt delivery leaves the same Goal paused and resumable.

Token accounting uses the host's committed cumulative projection, including input, output, reasoning, cache-read and cache-write tokens. While active, auxiliary title/compaction usage is conservatively included. The baseline is taken at the first primary request after activation/resume, preserving prior Goal usage across resumes. This avoids treating delayed prior-run usage as replacement-Goal work. Primary `context.options.maxTokens` is capped to the remaining budget without widening a smaller host cap. It is an output cap, not an exact total-spend ceiling: prompt/cache/reasoning costs and already-running tools can exceed the remaining total. The next primary request is interrupted once exhaustion is observed.

Default safety pauses are 25 observed Goal responses and three repeated normalized tool-free outputs. Resume and real user input start a fresh safety/blocker audit. Goal and read-only Plan starts are serialized in-process and mutually exclusive; these locks do not coordinate separate OpenCode server processes.

## Released API limits and remaining source differences

- The Promise plugin adapter does not forward the client's optional AbortSignal on `session.wait`. Cleanup invalidates detached waiters without waiting for them; a later resolution cannot submit work.
- The public API has no atomic “wait until idle and enqueue only if still idle” operation. A concurrently admitted user prompt can win the last admission race. Goal uses queued delivery and input-epoch invalidation; it does not claim atomic priority over outside clients.
- Context hooks have no request/message ID. Response ownership uses immutable dispatch-time authorization snapshots and native assistant message IDs, not a FIFO or a mutable Goal timestamp. Same-millisecond conflicting generations fail closed. Clock changes can prevent ownership confirmation; retry after the host settles instead of assuming a match.
- Native tools have no Pi `terminate` result. Goal interrupts the next primary boundary after a terminal helper, and retains ordinary permission handling. Sibling tools already dispatched in the same response cannot be recalled by a completed Goal helper.
- A compacted-away contract is restored at a saved retained-message boundary, preserving later message prefixes when native message IDs remain available. Missing retained IDs prevent that cache-stability guarantee.
- Source manager/settings UI, user-configurable safety limits, active elapsed-time display, legacy Pi queue-state migration and Pi branch/fork reconstruction remain unported. New OpenCode session IDs do not automatically inherit a parent's Goal.

## Verification

`npm run check` in this package includes deterministic Goal lifecycle, deferred-idle, input cancellation, clear/edit, duplicate-step, exact ownership, budget, Plan mutex, malformed-state, deadline reload and no-progress tests.

`node scripts/goal-host-smoke.mjs` loads Goal and Plan in a clean OpenCode 2.0.28 host with fresh HOME/XDG directories and a localhost scripted OpenAI-compatible provider. It verifies real native commands, incomplete-output continuation, completion, primary output caps, safety pauses, in-flight pause/clear, bounded wait deadlines, external-input wake and native retry behavior. No paid model calls or real credentials are used. Pass the official native executable as the first argument when it is not installed at the package-local CLI path: `node scripts/goal-host-smoke.mjs /path/to/opencode`. The smoke records source hashes and redacted evidence in its printed temporary directory.
