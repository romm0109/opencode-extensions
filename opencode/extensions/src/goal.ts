import type { PluginContext } from "./plugin-types.ts"
import { canResumeGoal, parseGoalCommand, recordGoalUsage, renderGoalStatus, startGoal, transitionGoal, validGoalState, type GoalState } from "./workflow-state.ts"

const GOAL_KEY = (sessionID: string) => `workflow/goal/${sessionID}`
const GOAL_TOOLS = ["goal_complete", "goal_blocked", "goal_wait"] as const

export async function registerGoal(ctx: PluginContext): Promise<() => void> {
  const stream = new AbortController()
  if (ctx.event) void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: stream.signal })) {
        if (event.type !== "session.step.ended") continue
        const current = await ctx.storage.get(GOAL_KEY(event.data.sessionID))
        if (!validGoalState(current) || current.status !== "active") continue
        const seen = current.usageEventIDs ?? []
        if (seen.includes(event.id)) continue
        const tokens = event.data.tokens.input + event.data.tokens.output + event.data.tokens.reasoning
        const next = recordGoalUsage(current, tokens, event.created)
        next.usageEventIDs = [...seen.slice(-199), event.id]
        await ctx.storage.set(GOAL_KEY(event.data.sessionID), toJson(next))
      }
    } catch (error) {
      if (!stream.signal.aborted) console.error("OpenCode goal usage stream stopped", error)
    }
  })()

  await ctx.session.hook("context", async (event) => {
    const current = await ctx.storage.get(GOAL_KEY(event.sessionID))
    if (!validGoalState(current)) return
    if (current.status === "active") {
      event.system.push({
        type: "text",
        text: [
          `Managed goal ${current.id} is active: ${current.objective}`,
          `Goal progress: ${current.automaticTurns}/${current.automaticTurnLimit} model responses; ${current.tokensUsed}${current.tokenBudget === undefined ? "" : `/${current.tokenBudget}`} tokens.`,
          `Continue substantive work until a verified result, a true blocker, or an external wait. End with goal_complete, goal_blocked, or goal_wait using this exact goal ID. Do not call goal_complete without concrete evidence.`,
        ].join("\n"),
      })
    } else {
      for (const name of GOAL_TOOLS) delete event.tools[name]
    }
  })

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "goal_complete",
      description: "Finish the exact active managed goal with a concise result and concrete verification evidence.",
      input: {
        type: "object", properties: {
          goal_id: { type: "string" }, summary: { type: "string", minLength: 1, maxLength: 4000 },
          evidence: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } },
        }, required: ["goal_id", "summary", "evidence"], additionalProperties: false,
      },
      execute: async (input, execution) => {
        const args = input as { goal_id: string; summary: string; evidence: string[] }
        const key = GOAL_KEY(execution.sessionID)
        const current = await ctx.storage.get(key)
        if (!validGoalState(current) || current.status !== "active" || current.id !== args.goal_id) {
          return { content: "Goal completion rejected: the supplied ID is not the exact active goal." }
        }
        if (!args.summary.trim() || !args.evidence.length || args.evidence.some((item) => !item.trim())) {
          return { content: "Goal completion rejected: provide a concise summary and concrete evidence." }
        }
        await ctx.storage.set(key, toJson(transitionGoal(current, "complete", { summary: args.summary.trim(), evidence: args.evidence.map((item) => item.trim()) })))
        return { content: `Goal ${current.id} completed. Summary: ${args.summary.trim()}\nEvidence: ${args.evidence.join("; ")}` }
      },
    })
    editor.add({
      name: "goal_blocked",
      description: "Stop a managed goal only after a repeated, evidenced impasse.",
      input: {
        type: "object", properties: {
          goal_id: { type: "string" }, reason: { type: "string", minLength: 1, maxLength: 2000 },
          evidence: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 500 } },
          repeated_turns: { type: "integer", minimum: 2 },
        }, required: ["goal_id", "reason", "evidence", "repeated_turns"], additionalProperties: false,
      },
      execute: async (input, execution) => {
        const args = input as { goal_id: string; reason: string; evidence: string[]; repeated_turns: number }
        const key = GOAL_KEY(execution.sessionID)
        const current = await ctx.storage.get(key)
        if (!validGoalState(current) || current.status !== "active" || current.id !== args.goal_id) return { content: "Block report rejected: the supplied ID is not the exact active goal." }
        if (args.repeated_turns < 2 || !args.reason.trim() || args.evidence.length === 0) return { content: "Block report rejected: describe a repeated impasse and include concrete evidence." }
        await ctx.storage.set(key, toJson(transitionGoal(current, "blocked", { lastError: args.reason.trim(), evidence: args.evidence.map((item) => item.trim()) })))
        return { content: `Goal ${current.id} blocked: ${args.reason.trim()}` }
      },
    })
    editor.add({
      name: "goal_wait",
      description: "Pause managed goal continuation while waiting for a named external event or bounded deadline.",
      input: {
        type: "object", properties: {
          goal_id: { type: "string" }, waiting_for: { type: "string", minLength: 1, maxLength: 1000 },
          resume_at: { type: "integer", minimum: 0 },
        }, required: ["goal_id", "waiting_for"], additionalProperties: false,
      },
      execute: async (input, execution) => {
        const args = input as { goal_id: string; waiting_for: string; resume_at?: number }
        const key = GOAL_KEY(execution.sessionID)
        const current = await ctx.storage.get(key)
        if (!validGoalState(current) || current.status !== "active" || current.id !== args.goal_id) return { content: "Wait request rejected: the supplied ID is not the exact active goal." }
        if (!args.waiting_for.trim() || (args.resume_at !== undefined && (args.resume_at < Date.now() || args.resume_at > Date.now() + 7 * 86_400_000))) return { content: "Wait request rejected: name the event and use a deadline within the next seven days." }
        await ctx.storage.set(key, toJson(transitionGoal(current, "waiting", { waitingFor: args.waiting_for.trim(), resumeAt: args.resume_at })))
        return { content: `Goal ${current.id} is waiting for: ${args.waiting_for.trim()}` }
      },
    })
  })

  await ctx.command.transform((editor) => editor.add({
    name: "goal",
    description: "Manage one session goal: start/edit, status, pause, resume, or clear",
    execute: async ({ sessionID, prompt }) => {
      const parsed = parseGoalCommand(prompt.text)
      if (parsed.kind === "error") {
        await ctx.session.synthetic({ sessionID, text: parsed.message, resume: false })
        return
      }
      const key = GOAL_KEY(sessionID)
      const current = await ctx.storage.get(key)
      const goal: GoalState | undefined = validGoalState(current) ? current : undefined
      if (parsed.kind === "status") {
        await ctx.session.synthetic({ sessionID, text: goal ? renderGoalStatus(goal) : "No active goal.", resume: false })
        return
      }
      if (parsed.kind === "clear") {
        await ctx.storage.remove(key)
        await ctx.session.synthetic({ sessionID, text: "Goal state cleared. Any already-running turn was not interrupted.", resume: false })
        return
      }
      if (parsed.kind === "pause") {
        if (!goal || goal.status !== "active") {
          await ctx.session.synthetic({ sessionID, text: "Only an active goal can be paused.", resume: false })
          return
        }
        await ctx.storage.set(key, toJson(transitionGoal(goal, "paused")))
        await ctx.session.interrupt({ sessionID })
        await ctx.session.synthetic({ sessionID, text: "Goal paused. Use /goal resume to continue it.", resume: false })
        return
      }
      if (parsed.kind === "resume") {
        if (!goal || !canResumeGoal(goal)) {
          await ctx.session.synthetic({ sessionID, text: goal?.status === "budget_limited" ? "The token budget is exhausted. Use /goal edit --tokens <new-budget> <objective> before resuming." : "This goal is not resumable. Start a goal with /goal <objective>.", resume: false })
          return
        }
        const resumed = transitionGoal(goal, "active", { waitingFor: undefined, resumeAt: undefined })
        await ctx.storage.set(key, toJson(resumed))
        await ctx.session.prompt({ sessionID, text: `Resume goal ${resumed.id}. Continue from the latest verified state; do not repeat completed work. Objective: ${resumed.objective}`, delivery: "steer" })
        return
      }
      if (parsed.kind === "edit") {
        if (!goal) {
          await ctx.session.synthetic({ sessionID, text: "There is no goal to edit. Use /goal <objective> to start one.", resume: false })
          return
        }
        const edited = { ...goal, objective: parsed.objective, updatedAt: Date.now(), ...(parsed.tokenBudget === undefined ? {} : { tokenBudget: parsed.tokenBudget }) }
        if (edited.tokenBudget !== undefined && edited.tokensUsed >= edited.tokenBudget) edited.status = "budget_limited"
        else if (goal.status === "active") edited.status = "active"
        await ctx.storage.set(key, toJson(edited))
        if (edited.status === "active") await ctx.session.prompt({ sessionID, text: `The active goal was edited. Continue with the updated objective and preserve existing verified progress: ${edited.objective}`, delivery: "steer" })
        else await ctx.session.synthetic({ sessionID, text: `Goal updated. Status: ${edited.status}.`, resume: false })
        return
      }
      if (goal?.status === "active") {
        await ctx.session.synthetic({ sessionID, text: "An active goal already exists. Use /goal edit <objective>, /goal pause, or /goal clear before starting another.", resume: false })
        return
      }
      const started = startGoal(parsed.objective, { tokenBudget: parsed.tokenBudget })
      await ctx.storage.set(key, toJson(started))
      await ctx.session.prompt({ sessionID, text: `Work toward this managed goal. Make verified progress, then continue only within the configured response/token budgets.\n\nGoal ID: ${started.id}\nObjective: ${started.objective}`, delivery: "steer" })
    },
  }))
  return () => stream.abort()
}

function toJson(value: GoalState): import("effect/Schema").Json {
  return JSON.parse(JSON.stringify(value)) as import("effect/Schema").Json
}
