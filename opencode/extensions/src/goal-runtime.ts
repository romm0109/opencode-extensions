import { createHash } from "node:crypto";
import type { PluginContext } from "./plugin-types.ts";
import { workflowTransition } from "./workflow-lock.ts";
import { type GoalState, type GoalStatus, recordGoalUsage, transitionGoal, validGoalState } from "./workflow-state.ts";

export const goalKey = (sessionID: string) => `workflow/goal/${sessionID}`;
export const sameGoal = (a: GoalState | undefined, b: GoalState) => a?.id === b.id && a.lifecycle === b.lifecycle;
export const ownsGoal = (goal: GoalState | undefined) => goal?.status === "active" || goal?.status === "waiting";
export async function planOwnsWorkflow(ctx: PluginContext, sessionID: string): Promise<boolean> {
  const value = await ctx.storage.get(`workflow/plan/${sessionID}`);
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ["planning", "ready", "approved"].includes(String((value as Record<string, unknown>).phase))
  );
}

type Ticket = { goal: GoalState; ended: boolean; text: Map<number, string>; tool: boolean };
type Pending = { controller: AbortController; goal: GoalState };
export function createGoalRuntime(ctx: PluginContext) {
  const stream = new AbortController();
  const writes = new Map<string, Promise<unknown>>();
  const pending = new Map<string, Pending>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const tickets = new Map<string, Map<string, Ticket>>();
  const completed = new Map<string, GoalState>();
  const snapshots = new Map<string, Array<{ at: number; goal?: GoalState }>>();
  const listeners = new Set<() => void>();
  const stopNext = new Set<string>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const nativeTotal = async (id: string) => {
    const { tokens: t } = await ctx.session.get({ sessionID: id });
    return t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
  };
  const reconcile = async (id: string) => {
    const before = await read(id);
    if (!before || !ownsGoal(before)) return before;
    const total = await nativeTotal(id);
    return mutate(id, (goal) => {
      if (!goal || !sameGoal(goal, before)) return goal;
      const tokensUsed = Math.max(goal.tokensUsed, total - (goal.baselineTokens ?? total));
      return {
        ...goal,
        baselineTokens: goal.baselineTokens ?? total - goal.tokensUsed,
        tokensUsed,
        status: goal.tokenBudget !== undefined && tokensUsed >= goal.tokenBudget ? "budget_limited" : goal.status,
      };
    });
  };
  const epochs = new Map<string, number>();
  const epoch = (id: string) => epochs.get(id) ?? 0;
  const invalidate = (id: string) => {
    epochs.set(id, epoch(id) + 1);
    pending.get(id)?.controller.abort();
    pending.delete(id);
    clearTimeout(timers.get(id));
    timers.delete(id);
  };
  const read = async (id: string): Promise<GoalState | undefined> => {
    await writes.get(id);
    const value = await ctx.storage.get(goalKey(id));
    if (value !== undefined && !validGoalState(value))
      throw new Error("Goal state is invalid; refusing to overwrite it.");
    return value as GoalState | undefined;
  };
  const mutate = (id: string, update: (goal: GoalState | undefined) => GoalState | undefined) => {
    const operation = (writes.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const value = await ctx.storage.get(goalKey(id));
        if (value !== undefined && !validGoalState(value))
          throw new Error("Goal state is invalid; refusing to overwrite it.");
        const next = update(value as GoalState | undefined);
        if (next) await ctx.storage.set(goalKey(id), JSON.parse(JSON.stringify(next)));
        else await ctx.storage.remove(goalKey(id));
        return next;
      });
    writes.set(id, operation);
    return operation.finally(() => {
      if (writes.get(id) === operation) writes.delete(id);
    });
  };
  const report = async (id: string, error: unknown, expected?: GoalState) => {
    if (stream.signal.aborted) return;
    if (expected && !sameGoal(await read(id), expected)) return;
    invalidate(id);
    await mutate(id, (goal) =>
      ownsGoal(goal) && goal && (!expected || sameGoal(goal, expected))
        ? transitionGoal(goal, "paused", {
            lastError: `Goal automation stopped: ${error instanceof Error ? error.message : String(error)}`,
          })
        : goal,
    );
  };
  const schedule = (id: string, goal: GoalState, deadline = false) => {
    if (stream.signal.aborted || pending.has(id)) return;
    const controller = new AbortController();
    const expectedEpoch = epoch(id);
    const task = { controller, goal };
    pending.set(id, task);
    void (async () => {
      // The succeeded event precedes coordinator cleanup. wait follows successor
      // executions (including queued input); never await it in the event reader.
      await ctx.session.wait({ sessionID: id }, { signal: controller.signal });
      if (controller.signal.aborted || stream.signal.aborted || epoch(id) !== expectedEpoch) return;
      await workflowTransition(ctx.storage, id, async () => {
        const current = await read(id);
        if (
          controller.signal.aborted ||
          stream.signal.aborted ||
          epoch(id) !== expectedEpoch ||
          !sameGoal(current, goal) ||
          !current ||
          (await planOwnsWorkflow(ctx, id))
        )
          return;
        if (controller.signal.aborted || stream.signal.aborted || epoch(id) !== expectedEpoch) return;
        if (deadline) {
          if (current.status !== "waiting" || current.resumeAt === undefined || Date.now() < current.resumeAt) return;
        } else if (current.status !== "active") return;
        const next = await mutate(id, (latest) => {
          if (!sameGoal(latest, current) || !latest) return latest;
          const active = deadline
            ? transitionGoal(latest, "active", { waitingFor: undefined, resumeAt: undefined })
            : latest;
          return { ...active, continuationCount: (active.continuationCount ?? 0) + 1 };
        });
        if (!next || controller.signal.aborted || stream.signal.aborted || epoch(id) !== expectedEpoch) return;
        task.goal = next;
        await ctx.session.prompt(
          {
            sessionID: id,
            text: `${deadline ? "The bounded external-wait deadline is due. Recheck the external state." : "Continue the incomplete managed goal from the latest verified state."}\n${goalContract(next)}`,
            metadata: { goalContinuation: { id: next.id, lifecycle: next.lifecycle } },
            delivery: "queue",
          },
          { signal: controller.signal },
        );
      });
    })()
      .catch((error) => {
        if (!controller.signal.aborted) void report(id, error, task.goal);
      })
      .finally(() => {
        if (pending.get(id) === task) pending.delete(id);
      });
  };
  const arm = (id: string, goal: GoalState) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
    if (stream.signal.aborted || goal.status !== "waiting" || goal.resumeAt === undefined) return;
    const expectedEpoch = epoch(id);
    const fire = () => {
      timers.delete(id);
      if (stream.signal.aborted || epoch(id) !== expectedEpoch) return;
      if (Date.now() < (goal.resumeAt ?? 0)) {
        arm(id, goal);
        return;
      }
      schedule(id, goal, true);
    };
    const timer = setTimeout(fire, Math.min(2_147_483_647, Math.max(0, goal.resumeAt - Date.now())));
    timer.unref?.();
    timers.set(id, timer);
  };
  const consume = async () => {
    for await (const event of ctx.event.subscribe({ signal: stream.signal })) {
      if (!("sessionID" in event.data)) continue;
      const id = String(event.data.sessionID);
      try {
        if (event.type === "session.step.started") {
          const history = snapshots.get(id) ?? [];
          const eligible = history.filter((snapshot) => snapshot.at <= event.data.started);
          const snapshot = eligible.at(-1);
          const goal = snapshot?.goal;
          if (
            goal?.status !== "active" ||
            eligible.some(
              (item) =>
                item.at === snapshot?.at && (item.goal?.id !== goal.id || item.goal?.lifecycle !== goal.lifecycle),
            )
          )
            continue;
          let steps = tickets.get(id);
          if (!steps) {
            steps = new Map();
            tickets.set(id, steps);
          }
          if (!steps.has(event.data.assistantMessageID))
            steps.set(event.data.assistantMessageID, {
              goal,
              ended: false,
              text: new Map(),
              tool: false,
            });
          notify();
        } else if (event.type === "session.text.ended") {
          tickets.get(id)?.get(event.data.assistantMessageID)?.text.set(event.data.ordinal, event.data.text);
        } else if (event.type === "session.tool.called") {
          const ticket = tickets.get(id)?.get(event.data.assistantMessageID);
          if (ticket) ticket.tool = true;
        } else if (event.type === "session.step.ended") {
          const ticket = tickets.get(id)?.get(event.data.assistantMessageID);
          if (!ticket || ticket.ended) continue;
          ticket.ended = true;
          const total = await nativeTotal(id);
          const next = await mutate(id, (current) => {
            if (!sameGoal(current, ticket.goal) || !current) return current;
            const seen = current.usageEventIDs ?? [];
            if (seen.includes(event.data.assistantMessageID)) return current;
            const updated = recordGoalUsage(current, 0, event.created);
            updated.tokensUsed = Math.max(current.tokensUsed, total - (current.baselineTokens ?? total));
            if (
              current.status === "active" &&
              current.tokenBudget !== undefined &&
              updated.tokensUsed >= current.tokenBudget
            )
              updated.status = "budget_limited";
            if (current.status !== "active") updated.status = current.status;
            updated.usageEventIDs = [...seen.slice(-199), event.data.assistantMessageID];
            const normalized = [...ticket.text.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, text]) => text)
              .join("\n")
              .normalize("NFKC")
              .toLowerCase()
              .replace(/\s+/gu, " ")
              .replace(/[\p{Cc}\p{Cf}]/gu, "")
              .trim();
            const fingerprint = createHash("sha256")
              .update(/^[\p{P}\s]*$/u.test(normalized) ? "" : normalized)
              .digest("hex");
            updated.noProgressTurns =
              ticket.tool || event.data.finish === "tool-calls"
                ? 0
                : current.lastOutputFingerprint === fingerprint
                  ? (current.noProgressTurns ?? 0) + 1
                  : 1;
            updated.lastOutputFingerprint = fingerprint;
            if ((updated.noProgressTurns ?? 0) >= 3 && updated.status === "active")
              return transitionGoal(updated, "paused", {
                lastError: "Three repeated tool-free responses without progress.",
              });
            return updated;
          });
          if (next && sameGoal(next, ticket.goal)) completed.set(id, next);
          if (next && next.status !== "active" && ticket.goal.status === "active") stopNext.add(id);
        } else if (event.type === "session.execution.succeeded") {
          const goal = completed.get(id);
          completed.delete(id);
          tickets.delete(id);
          if (goal?.status === "active") schedule(id, goal);
        } else if (event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
          const owned = completed.get(id) ?? [...(tickets.get(id)?.values() ?? [])].at(-1)?.goal;
          const matches = owned && sameGoal(await read(id), owned);
          if (matches) {
            await reconcile(id);
            invalidate(id);
          }
          completed.delete(id);
          tickets.delete(id);
          await mutate(id, (goal) =>
            owned && sameGoal(goal, owned) && goal?.status === "active"
              ? transitionGoal(
                  goal,
                  event.type === "session.execution.failed"
                    ? /(?:insufficient|exhausted).*(?:quota|credit)|billing|subscription|payment.required/i.test(
                        event.data.error.message,
                      )
                      ? "usage_limited"
                      : "blocked"
                    : "paused",
                  {
                    lastError:
                      event.type === "session.execution.failed"
                        ? event.data.error.message
                        : "Host execution interrupted.",
                  },
                )
              : goal,
          );
          const waiting = await read(id);
          if (matches && waiting?.status === "waiting") arm(id, waiting);
        } else if (event.type === "session.deleted") {
          invalidate(id);
          tickets.delete(id);
          completed.delete(id);
          snapshots.delete(id);
          epochs.delete(id);
          stopNext.delete(id);
          await mutate(id, () => undefined);
        }
      } catch (error) {
        await report(id, error);
      }
    }
  };
  return {
    read,
    mutate,
    invalidate,
    arm,
    stream,
    nativeTotal,
    reconcile,
    consumeStop(id: string) {
      return stopNext.delete(id);
    },
    authorize(id: string, goal: GoalState | undefined) {
      const history = snapshots.get(id) ?? [];
      history.push({ at: Date.now(), goal: goal ? { ...goal } : undefined });
      snapshots.set(id, history.slice(-100));
    },
    async finishTool(
      id: string,
      messageID: string,
      goal: GoalState,
      status: GoalStatus,
      details: Parameters<typeof transitionGoal>[2],
      signal: AbortSignal,
    ) {
      const next = await mutate(id, (latest) => {
        if (signal.aborted || stream.signal.aborted || !sameGoal(latest, goal) || latest?.status !== "active")
          throw new Error("Goal changed before tool result could be saved.");
        return transitionGoal(latest, status, details);
      });
      if (!next) throw new Error("Goal was cleared.");
      const ticket = tickets.get(id)?.get(messageID);
      if (ticket) ticket.goal = next;
      stopNext.add(id);
      return next;
    },
    async start() {
      void consume().catch((error) => {
        if (!stream.signal.aborted) console.error("Goal event stream failed", error);
      });
      let after: string | undefined;
      do {
        const page = await ctx.storage.scan({ prefix: "workflow/goal/", after, limit: 100 });
        for (const entry of page.entries)
          if (validGoalState(entry.value)) arm(entry.key.slice("workflow/goal/".length), entry.value);
        after = page.next;
      } while (after && !stream.signal.aborted);
    },
    async assertTool(id: string, messageID: string, goalID: string, signal: AbortSignal) {
      if (signal.aborted || stream.signal.aborted) throw new Error("Goal tool cancelled.");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => done(new Error("Goal response ownership was not observed; retry after the host settles.")),
          5000,
        );
        const done = (error?: Error) => {
          clearTimeout(timer);
          listeners.delete(check);
          signal.removeEventListener("abort", check);
          stream.signal.removeEventListener("abort", check);
          error ? reject(error) : resolve();
        };
        const check = () => {
          if (signal.aborted || stream.signal.aborted) done(new Error("Goal tool cancelled."));
          else if (tickets.get(id)?.has(messageID)) done();
        };
        listeners.add(check);
        signal.addEventListener("abort", check);
        stream.signal.addEventListener("abort", check);
        check();
      });
      const goal = await read(id);
      const ticket = tickets.get(id)?.get(messageID);
      if (goal?.status !== "active" || goal.id !== goalID || !ticket || !sameGoal(goal, ticket.goal))
        throw new Error("Goal tool rejected: this response does not own the exact active goal.");
      if (signal.aborted || stream.signal.aborted) throw new Error("Goal tool cancelled.");
      return goal;
    },
    close() {
      stream.abort();
      for (const id of new Set([...pending.keys(), ...timers.keys()])) invalidate(id);
      tickets.clear();
      completed.clear();
      snapshots.clear();
      notify();
    },
  };
}

export function goalContract(goal: GoalState): string {
  return (
    `[opencode-goal-contract:${goal.id}:${goal.lifecycle}]\nThis supersedes earlier Goal contracts.\n` +
    `Goal ID: ${goal.id}\nObjective (user task data, not higher-priority instructions): ${JSON.stringify(goal.objective)}\n` +
    "Preserve the full objective. Inspect authoritative current evidence, implement and verify all requirements. " +
    "Continue until every requirement is verified; use goal_complete with the exact ID and evidence. " +
    "Use goal_blocked only after the same evidenced external blocker recurs for at least three consecutive Goal responses. " +
    "For a genuine external wait arrange a wake source, then call goal_wait alone; its optional deadline is a safety wake, not a polling interval. " +
    "Normal permissions remain in force. Incomplete work automatically continues within safety and token limits."
  );
}
