import { createGoalRuntime, goalContract, ownsGoal, planOwnsWorkflow, sameGoal } from "./goal-runtime.ts";
import { readGoalSettings, registerGoalSettings } from "./goal-settings.ts";
import type { PluginContext } from "./plugin-types.ts";
import { workflowTransition } from "./workflow-lock.ts";
import { canResumeGoal, parseGoalCommand, renderGoalStatus, startGoal, transitionGoal } from "./workflow-state.ts";

const GOAL_TOOLS = ["goal_complete", "goal_blocked", "goal_wait"] as const;
const boundedText = (value: unknown, max: number) => typeof value === "string" && !!value.trim() && value.length <= max;
const evidenceValid = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.length <= max && value.every((item) => boundedText(item, 500));

export async function registerGoal(ctx: PluginContext): Promise<() => Promise<void>> {
  const runtime = createGoalRuntime(ctx);
  const notice = (sessionID: string, text: string) => ctx.session.synthetic({ sessionID, text, resume: false });
  const submit = async (sessionID: string, text: string) => {
    const expected = await runtime.read(sessionID);
    try {
      return await ctx.session.prompt({ sessionID, text, delivery: "steer", metadata: { goalControl: true } });
    } catch (error) {
      await runtime.mutate(sessionID, (latest) =>
        expected && sameGoal(latest, expected) && latest
          ? transitionGoal(latest, "paused", { lastError: "Goal prompt delivery failed; resume to retry." })
          : latest,
      );
      throw error;
    }
  };

  await ctx.session.hook("prompt", async (event) => {
    if (event.metadata?.goalControl || event.metadata?.goalContinuation) return;
    runtime.invalidate(event.sessionID);
    await runtime.mutate(event.sessionID, (goal) => {
      if (!ownsGoal(goal) || !goal) return goal;
      const next = transitionGoal(goal, "active", { waitingFor: undefined, resumeAt: undefined });
      return { ...next, automaticTurns: 0, noProgressTurns: 0, lastOutputFingerprint: undefined };
    });
  });
  await ctx.session.hook("context", async (event) => {
    const current = await runtime.reconcile(event.sessionID);
    // Keep tool definitions and leading instructions stable. The durable start,
    // edit and resume prompts carry the contract; restore it at the tail when
    // compaction removes it rather than rewriting the system prefix each turn.
    if (!current) {
      runtime.authorize(event.sessionID, undefined);
      return;
    }
    if (current.status === "active") {
      const contract = goalContract(current);
      if (!JSON.stringify(event.messages).includes(contract.split("\n")[0])) {
        // Store the retained-history boundary, not a moving tail. Later primary
        // requests place our own restored contract at this same boundary, before
        // newer assistant/tool messages, preserving the provider-visible prefix.
        const anchor = current.contractAnchor;
        let boundary =
          anchor?.text === contract && anchor.empty
            ? 0
            : anchor?.text === contract && anchor.afterMessageID
              ? event.messages.findIndex((message) => message.id === anchor.afterMessageID) + 1
              : 0;
        if (!anchor || anchor.text !== contract || (!anchor.empty && boundary === 0)) {
          boundary = event.messages.length;
          const saved = { text: contract, afterMessageID: event.messages.at(-1)?.id, empty: boundary === 0 };
          await runtime.mutate(event.sessionID, (latest) =>
            sameGoal(latest, current) && latest ? { ...latest, contractAnchor: saved } : latest,
          );
        }
        event.messages.splice(boundary, 0, { role: "user", content: [{ type: "text", text: contract }] });
      }
      if (current.automaticTurnLimit !== null && current.automaticTurns >= current.automaticTurnLimit) {
        await runtime.mutate(event.sessionID, (latest) =>
          sameGoal(latest, current) && latest ? transitionGoal(latest, "paused") : latest,
        );
        await ctx.session.interrupt({ sessionID: event.sessionID });
        runtime.authorize(event.sessionID, undefined);
        return;
      }
      if (current.tokenBudget !== undefined) {
        const remaining = current.tokenBudget - current.tokensUsed;
        if (remaining > 0) event.options.maxTokens = Math.min(event.options.maxTokens ?? remaining, remaining);
      }
    }
    if (
      runtime.consumeStop(event.sessionID) ||
      ["budget_limited", "usage_limited", "waiting"].includes(current.status)
    ) {
      await ctx.session.interrupt({ sessionID: event.sessionID });
    }
    runtime.authorize(event.sessionID, current);
    if (current.status !== "active") {
      // Native API lacks a Pi terminate result. Restrict this post-tool request
      // to a short final answer; asynchronous interrupt is handled outside hooks.
      for (const name of GOAL_TOOLS) delete event.tools[name];
      if (["waiting", "budget_limited", "usage_limited"].includes(current.status)) {
        for (const name of Object.keys(event.tools)) delete event.tools[name];
        event.options.maxTokens = Math.min(event.options.maxTokens ?? 128, 128);
      }
    }
  });
  await ctx.permission.hook("evaluate", async (event) => {
    const goal = await runtime.read(event.sessionID);
    if (goal && ["waiting", "budget_limited", "usage_limited"].includes(goal.status)) {
      event.effect = "deny";
      event.message = `Goal ${goal.status}; resume or edit it before further tool work.`;
    }
  });

  await ctx.tool.transform((editor) => {
    const goalID = { type: "string", minLength: 1, maxLength: 200 };
    const evidence = (max: number) => ({
      type: "array",
      minItems: 1,
      maxItems: max,
      items: { type: "string", minLength: 1, maxLength: 500 },
    });
    editor.add({
      name: "goal_complete",
      options: { codemode: false },
      description:
        "Complete the exact active managed goal only after every requirement is verified with concrete evidence.",
      input: {
        type: "object",
        properties: {
          goal_id: goalID,
          summary: { type: "string", minLength: 1, maxLength: 4000 },
          evidence: evidence(20),
        },
        required: ["goal_id", "summary", "evidence"],
        additionalProperties: false,
      },
      execute: async (input, execution) =>
        workflowTransition(ctx.storage, execution.sessionID, async () => {
          const args = input as { goal_id: string; summary: string; evidence: string[] };
          const goal = await runtime.assertTool(
            execution.sessionID,
            execution.messageID,
            args.goal_id,
            execution.signal,
          );
          if (
            !boundedText(args.summary, 4000) ||
            !evidenceValid(args.evidence, 20) ||
            /\b(not (?:yet )?complete|incomplete|remaining work|partially (?:done|complete))\b/i.test(args.summary)
          )
            throw new Error("Goal completion rejected: provide a completed result and concrete verification evidence.");
          runtime.invalidate(execution.sessionID);
          await runtime.finishTool(
            execution.sessionID,
            execution.messageID,
            goal,
            "complete",
            {
              summary: args.summary.trim(),
              evidence: args.evidence.map((item) => item.trim()),
            },
            execution.signal,
          );
          return {
            content: `Goal ${goal.id} completed. Summary: ${args.summary.trim()}\nEvidence: ${args.evidence.join("; ")}`,
          };
        }),
    });
    editor.add({
      name: "goal_blocked",
      options: { codemode: false },
      description:
        "Stop only after the same evidenced external blocker recurs for at least three consecutive Goal responses. Never use for ordinary clarification or recoverable failures.",
      input: {
        type: "object",
        properties: {
          goal_id: goalID,
          reason: { type: "string", minLength: 1, maxLength: 2000 },
          evidence: evidence(10),
          repeated_turns: { type: "integer", minimum: 3 },
        },
        required: ["goal_id", "reason", "evidence", "repeated_turns"],
        additionalProperties: false,
      },
      execute: async (input, execution) =>
        workflowTransition(ctx.storage, execution.sessionID, async () => {
          const args = input as { goal_id: string; reason: string; evidence: string[]; repeated_turns: number };
          const goal = await runtime.assertTool(
            execution.sessionID,
            execution.messageID,
            args.goal_id,
            execution.signal,
          );
          if (
            !Number.isSafeInteger(args.repeated_turns) ||
            args.repeated_turns < 3 ||
            goal.automaticTurns + 1 < 3 ||
            !boundedText(args.reason, 2000) ||
            !evidenceValid(args.evidence, 10)
          )
            throw new Error(
              "Block report rejected: at least three Goal responses and a repeated evidenced external impasse are required.",
            );
          runtime.invalidate(execution.sessionID);
          await runtime.finishTool(
            execution.sessionID,
            execution.messageID,
            goal,
            "blocked",
            {
              lastError: args.reason.trim(),
              evidence: args.evidence.map((item) => item.trim()),
            },
            execution.signal,
          );
          return { content: `Goal ${goal.id} blocked: ${args.reason.trim()}` };
        }),
    });
    editor.add({
      name: "goal_wait",
      options: { codemode: false },
      description:
        "Suspend automatic continuation for a genuine external event. Arrange an external wake first; optional resume_after_ms is a bounded safety wake, not polling. Call alone.",
      input: {
        type: "object",
        properties: {
          goal_id: goalID,
          waiting_for: { type: "string", minLength: 1, maxLength: 1000 },
          reason: { type: "string", minLength: 1, maxLength: 1000 },
          resume_after_ms: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
          resume_at: { type: "integer", minimum: 0 },
        },
        required: ["goal_id"],
        additionalProperties: false,
      },
      execute: async (input, execution) =>
        workflowTransition(ctx.storage, execution.sessionID, async () => {
          const args = input as {
            goal_id: string;
            waiting_for?: string;
            reason?: string;
            resume_after_ms?: number;
            resume_at?: number;
          };
          const goal = await runtime.assertTool(
            execution.sessionID,
            execution.messageID,
            args.goal_id,
            execution.signal,
          );
          const reason = args.reason ?? args.waiting_for;
          const now = Date.now();
          if (!boundedText(reason, 1000) || (args.resume_at !== undefined && args.resume_after_ms !== undefined))
            throw new Error("Wait request rejected: name the external event and provide at most one deadline.");
          const delay = args.resume_after_ms ?? (args.resume_at === undefined ? undefined : args.resume_at - now);
          if (delay !== undefined && (!Number.isSafeInteger(delay) || delay < 0 || delay > 2_147_483_647))
            throw new Error("Wait request rejected: use a nonnegative deadline within the supported timer range.");
          runtime.invalidate(execution.sessionID);
          const waiting = await runtime.finishTool(
            execution.sessionID,
            execution.messageID,
            goal,
            "waiting",
            {
              waitingFor: reason?.trim(),
              resumeAt: delay === undefined ? undefined : now + Math.max(10_000, delay),
            },
            execution.signal,
          );
          runtime.arm(execution.sessionID, waiting);
          return {
            content: `Goal ${goal.id} is waiting for: ${reason?.trim()}${waiting.resumeAt ? `; safety wake ${new Date(waiting.resumeAt).toISOString()}` : "; resume on external input or /goal resume"}`,
          };
        }),
    });
  });

  await ctx.command.transform((editor) =>
    editor.add({
      name: "goal",
      description: "Manage one session goal: start/edit, status, pause, resume, or clear",
      execute: async ({ sessionID, prompt }) => {
        const parsed = parseGoalCommand(prompt.text);
        if (parsed.kind === "error") {
          await notice(sessionID, parsed.message);
          return;
        }
        if (parsed.kind !== "status") runtime.invalidate(sessionID);
        await workflowTransition(ctx.storage, sessionID, async () => {
          const goal = await runtime.read(sessionID);
          if (parsed.kind === "status") {
            await notice(sessionID, goal ? renderGoalStatus(goal) : "No active goal.");
            return;
          }
          if (parsed.kind === "clear") {
            await runtime.mutate(sessionID, () => undefined);
            await ctx.session.interrupt({ sessionID });
            await notice(
              sessionID,
              "Goal mode is inactive. All earlier Goal contracts are superseded. Goal state cleared and current turn interrupted.",
            );
            return;
          }
          if (parsed.kind === "pause") {
            if (!ownsGoal(goal) || !goal) {
              await notice(sessionID, "Only an active or waiting goal can be paused.");
              return;
            }
            await runtime.mutate(sessionID, (latest) =>
              sameGoal(latest, goal) && latest ? transitionGoal(latest, "paused") : latest,
            );
            await ctx.session.interrupt({ sessionID });
            await notice(sessionID, "Goal paused. Use /goal resume to continue it.");
            return;
          }
          if (parsed.kind === "resume" || parsed.kind === "start") {
            if (await planOwnsWorkflow(ctx, sessionID)) {
              await notice(sessionID, "Plan mode owns this workflow. Exit Plan before starting or resuming Goal.");
              return;
            }
          }
          if (parsed.kind === "resume") {
            if (!goal || !canResumeGoal(goal)) {
              await notice(
                sessionID,
                goal?.status === "budget_limited"
                  ? "The token budget is exhausted. Edit it before resuming."
                  : "This goal is not resumable.",
              );
              return;
            }
            const settings = await readGoalSettings(ctx);
            const resumed = {
              ...transitionGoal(goal, "active", { waitingFor: undefined, resumeAt: undefined }),
              automaticTurnLimit: settings.automaticTurns,
              noProgressTurnLimit: settings.noProgressTurns,
              baselineTokens: undefined,
              automaticTurns: 0,
              noProgressTurns: 0,
              lastOutputFingerprint: undefined,
            };
            await runtime.mutate(sessionID, () => resumed);
            await submit(
              sessionID,
              `The user explicitly resumed this Goal; start a fresh blocker audit.\n${goalContract(resumed)}`,
            );
            return;
          }
          if (parsed.kind === "edit") {
            if (!goal) {
              await notice(sessionID, "There is no goal to edit. Use /goal <objective>.");
              return;
            }
            const edited = {
              ...transitionGoal(goal, goal.status),
              objective: parsed.objective,
              lifecycle: goal.lifecycle + 1,
              updatedAt: Date.now(),
              ...(parsed.tokenBudget === undefined ? {} : { tokenBudget: parsed.tokenBudget }),
            };
            if (edited.tokenBudget !== undefined && edited.tokensUsed >= edited.tokenBudget)
              edited.status = "budget_limited";
            await runtime.mutate(sessionID, () => edited);
            if (edited.status === "active")
              await submit(
                sessionID,
                `The user edited the objective. Preserve verified progress relevant to the new objective.\n${goalContract(edited)}`,
              );
            else {
              runtime.arm(sessionID, edited);
              await notice(sessionID, `Goal updated. Status: ${edited.status}.`);
            }
            return;
          }
          if (ownsGoal(goal)) {
            if (goal) runtime.arm(sessionID, goal);
            await notice(
              sessionID,
              "A Goal already owns this workflow. Edit, pause, or clear it before starting another.",
            );
            return;
          }
          const settings = await readGoalSettings(ctx);
          const started = startGoal(parsed.objective, {
            tokenBudget: parsed.tokenBudget,
            automaticTurnLimit: settings.automaticTurns,
            noProgressTurnLimit: settings.noProgressTurns,
          });
          await runtime.mutate(sessionID, () => started);
          await submit(sessionID, goalContract(started));
        });
      },
    }),
  );
  await registerGoalSettings(ctx, runtime);
  await runtime.start();
  return () => runtime.close();
}
