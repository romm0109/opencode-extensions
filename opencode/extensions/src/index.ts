import { Plugin } from "@opencode/plugin"

type ProgressStep = { text: string; done: boolean }
type GoalState = { objective: string; status: "active" | "paused"; createdAt: number }

const GOAL_PREFIX = "session/goal/"
const PLAN_PREFIX = "session/plan/"
const PROGRESS_PREFIX = "session/progress/"

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 4000) : ""
}

function validSteps(value: unknown): ProgressStep[] | undefined {
  if (!Array.isArray(value) || value.length > 30) return undefined
  const result: ProgressStep[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined
    const row = item as Record<string, unknown>
    const text = clean(row.text)
    if (!text || typeof row.done !== "boolean") return undefined
    result.push({ text, done: row.done })
  }
  return result
}

function renderProgress(steps: ProgressStep[]): string {
  return steps.map((step) => `${step.done ? "[x]" : "[ ]"} ${step.text}`).join("\n")
}

export default Plugin.define({
  id: "romm0109.workflow",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "update_progress",
        description: "Set or update the current session's checklist. This records progress; it does not claim work is complete.",
        input: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              maxItems: 30,
              items: {
                type: "object",
                properties: { text: { type: "string" }, done: { type: "boolean" } },
                required: ["text", "done"],
                additionalProperties: false,
              },
            },
          },
          required: ["steps"],
          additionalProperties: false,
        },
        execute: async (input, execution) => {
          const steps = validSteps((input as { steps?: unknown }).steps)
          if (!steps || steps.length === 0) {
            return { content: "Progress was not changed. Supply 1–30 steps with text and done fields." }
          }
          await ctx.storage.set(`${PROGRESS_PREFIX}${execution.sessionID}`, steps)
          return { content: `Progress saved for this session:\n${renderProgress(steps)}` }
        },
      })
    })

    await ctx.session.hook("context", async (event) => {
      const [goal, planning, progress] = await Promise.all([
        ctx.storage.get(`${GOAL_PREFIX}${event.sessionID}`),
        ctx.storage.get(`${PLAN_PREFIX}${event.sessionID}`),
        ctx.storage.get(`${PROGRESS_PREFIX}${event.sessionID}`),
      ])
      const lines: string[] = []
      if (goal && typeof goal === "object") {
        const value = goal as Partial<GoalState>
        if (typeof value.objective === "string" && value.status === "active") {
          lines.push(`Active goal: ${value.objective}`, "Work toward this goal; verify completion before claiming it is done.")
        }
      }
      if (planning === true) {
        lines.push("Planning mode is active. Analyze and propose a plan without modifying files or running mutating tools.")
      }
      const steps = validSteps(progress)
      if (steps?.length) lines.push(`Current progress:\n${renderProgress(steps)}`)
      if (lines.length) event.system.push({ type: "text", text: lines.join("\n\n") })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description: "Start or inspect a session-scoped goal: /goal <objective>, /goal status, /goal clear",
        execute: async ({ sessionID, prompt }) => {
          const argument = clean(prompt.text).replace(/^\/goal\s*/i, "")
          const key = `${GOAL_PREFIX}${sessionID}`
          if (argument.toLowerCase() === "clear") {
            await ctx.storage.remove(key)
            await ctx.session.synthetic({ sessionID, text: "Goal cleared." })
            return
          }
          if (argument.toLowerCase() === "status" || !argument) {
            const goal = await ctx.storage.get(key) as Partial<GoalState> | undefined
            await ctx.session.synthetic({ sessionID, text: goal?.objective ? `Active goal: ${goal.objective}` : "No active goal." })
            return
          }
          await ctx.storage.set(key, { objective: argument, status: "active", createdAt: Date.now() })
          await ctx.storage.remove(`${PROGRESS_PREFIX}${sessionID}`)
          await ctx.session.synthetic({ sessionID, text: `Goal set: ${argument}` })
        },
      })

      editor.add({
        name: "plan",
        description: "Toggle a read-only planning instruction for this session: /plan on|off|status",
        execute: async ({ sessionID, prompt }) => {
          const argument = clean(prompt.text).replace(/^\/plan\s*/i, "").toLowerCase()
          const key = `${PLAN_PREFIX}${sessionID}`
          if (argument === "off") {
            await ctx.storage.set(key, false)
            await ctx.session.synthetic({ sessionID, text: "Planning mode is off." })
            return
          }
          if (argument === "status") {
            const enabled = await ctx.storage.get(key)
            await ctx.session.synthetic({ sessionID, text: enabled === true ? "Planning mode is on." : "Planning mode is off." })
            return
          }
          await ctx.storage.set(key, true)
          await ctx.session.synthetic({ sessionID, text: "Planning mode is on. The plugin will request read-only planning behavior in future model calls; it does not enforce tool permissions." })
        },
      })
    })
  },
})
