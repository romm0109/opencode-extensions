import type { PluginContext } from "./plugin-types.ts"

type PlanState = { phase: "planning" | "ready" | "approved" | "implementing"; task: string; plan?: string; priorAgent?: string }
const key = (sessionID: string) => `workflow/plan/${sessionID}`
const mutations = /^(write|edit|patch|apply_patch|delete|remove|move|rename|create|mkdir|touch|chmod|chown|install|uninstall|worktree_add|worktree_remove|bash|shell)$/i

export function commandPlan(raw: string): { kind: string; task?: string } {
  const text = raw.trim().replace(/^\/plan(?:\s+)?/i, "")
  if (!text) return { kind: "status" }
  const [verb, ...rest] = text.split(/\s+/)
  if (["status", "off", "exit", "finalize", "approve", "implement", "start"].includes(verb!.toLowerCase())) {
    return { kind: verb!.toLowerCase(), ...(rest.length ? { task: rest.join(" ") } : {}) }
  }
  if (["on", "enter"].includes(verb!.toLowerCase())) return { kind: "start", ...(rest.length ? { task: rest.join(" ") } : {}) }
  // Treat arbitrary input as the original planning request, preserving it verbatim.
  return { kind: "start", task: text }
}

export function isMutatingToolName(name: string): boolean {
  const normalized = name.replace(/^.*\./, "").replace(/[-\s]/g, "_")
  return mutations.test(normalized) || /^(write|edit|patch|delete|remove|apply|create|move|rename|install|uninstall)_/.test(normalized)
}

export async function registerPlan(ctx: PluginContext): Promise<void> {
  await ctx.session.hook("context", async (event) => {
    const state = await ctx.storage.get(key(event.sessionID)) as PlanState | undefined
    if (!isPlanState(state) || state.phase === "implementing") return
    event.system.push({ type: "text", text: `Plan mode (${state.phase}) for task: ${state.task}. Read and inspect only. Do not modify files, run mutating commands, or execute write tools. Ask concise structured questions when requirements are unclear. When the plan is complete, call plan_complete with the plan and wait for explicit user approval and handoff.` })
    if (state.phase === "planning" || state.phase === "ready") {
      for (const name of Object.keys(event.tools)) if (isMutatingToolName(name)) delete event.tools[name]
    }
  })

  await ctx.permission.hook("evaluate", async (event) => {
    const state = await ctx.storage.get(key(event.sessionID))
    if (!isPlanState(state) || state.phase === "implementing") return
    if (isMutatingToolName(event.action)) event.effect = "deny"
  })

  await ctx.tool.transform((editor) => editor.add({
    name: "plan_complete",
    description: "Submit a concrete implementation plan for user review. Does not approve or execute the plan.",
    input: { type: "object", properties: { plan: { type: "string", minLength: 1, maxLength: 50000 }, questions: { type: "array", maxItems: 3, items: { type: "object", properties: { question: { type: "string", minLength: 1, maxLength: 500 }, options: { type: "array", minItems: 2, maxItems: 4, items: { type: "string", minLength: 1, maxLength: 200 } } }, required: ["question", "options"], additionalProperties: false } } }, required: ["plan"], additionalProperties: false },
    execute: async (input, execution) => {
      const args = input as { plan: string; questions?: Array<{ question: string; options: string[] }> }
      const state = await ctx.storage.get(key(execution.sessionID)) as PlanState | undefined
      if (!isPlanState(state) || state.phase === "implementing") return { content: "No active plan review is available." }
      const updated: PlanState = { ...state, phase: "ready", plan: args.plan.trim() }
      await ctx.storage.set(key(execution.sessionID), toJson(updated))
      const questions = (args.questions ?? []).map((item, index) => `${index + 1}. ${item.question}\n${item.options.map((option, optionIndex) => `   ${String.fromCharCode(65 + optionIndex)}. ${option}`).join("\n")}`).join("\n")
      return { content: `Plan saved for review. No changes have been made. The user must run /plan approve, then /plan implement to hand off.\n\n${updated.plan}${questions ? `\n\nQuestions:\n${questions}` : ""}` }
    },
  }))

  await ctx.command.transform((editor) => editor.add({
    name: "plan",
    description: "Plan read-only work, review, and explicitly hand off: /plan <task>, /plan approve, /plan implement, /plan exit",
    execute: async ({ sessionID, prompt }) => {
      const parsed = commandPlan(prompt.text)
      const stored = await ctx.storage.get(key(sessionID))
      const current = isPlanState(stored) ? stored : undefined
      const notice = async (text: string) => ctx.session.synthetic({ sessionID, text, resume: false })
      if (parsed.kind === "status") {
        await notice(current ? `Plan mode ${current.phase}: ${current.task}${current.plan ? `\n\n${current.plan}` : ""}` : "Plan mode is off.")
      } else if (parsed.kind === "off" || parsed.kind === "exit") {
        await ctx.storage.remove(key(sessionID)); await notice("Plan mode is off.")
      } else if (parsed.kind === "start") {
        const task = parsed.task?.trim() || current?.task
        if (!task) { await notice("Usage: /plan <task>"); return }
        const session = await ctx.session.get({ sessionID })
        const priorAgent = current?.priorAgent ?? session.agent
        await ctx.storage.set(key(sessionID), toJson({ phase: "planning", task, ...(priorAgent ? { priorAgent } : {}) }))
        await ctx.session.switchAgent({ sessionID, agent: "plan" })
        await ctx.session.prompt({ sessionID, text: `Plan this task without implementing it. Preserve the request exactly: ${task}`, delivery: "steer" })
      } else if (parsed.kind === "approve") {
        if (!current || current.phase !== "ready" || !current.plan) { await notice("There is no completed plan to approve yet."); return }
        await ctx.storage.set(key(sessionID), toJson({ ...current, phase: "approved" }))
        await notice(`Plan approved for handoff. Review it, then run /plan implement to begin.\n\n${current.plan}`)
      } else if (parsed.kind === "implement") {
        if (!current || current.phase !== "approved") { await notice("Approve a completed plan with /plan approve before handing it off."); return }
        await ctx.storage.set(key(sessionID), toJson({ ...current, phase: "implementing" }))
        if (current.priorAgent) {
          await ctx.session.switchAgent({ sessionID, agent: current.priorAgent })
        }
        await ctx.session.prompt({ sessionID, text: `The user explicitly approved this plan and handed off implementation. Follow the plan, respecting normal host permissions.\n\nTask: ${current.task}\n\nApproved plan:\n${current.plan}`, delivery: "steer" })
      } else if (parsed.kind === "finalize") {
        await notice("Submit a concrete plan using plan_complete, then review and approve it.")
      } else {
        await notice("Unknown /plan command. Use /plan <task>, status, approve, implement, or exit.")
      }
    },
  }))
}

function isPlanState(value: unknown): value is PlanState {
  if (!value || typeof value !== "object") return false
  const state = value as Partial<PlanState>
  return ["planning", "ready", "approved", "implementing"].includes(String(state.phase)) && typeof state.task === "string"
}

function toJson(value: PlanState): import("effect/Schema").Json {
  return JSON.parse(JSON.stringify(value)) as import("effect/Schema").Json
}
