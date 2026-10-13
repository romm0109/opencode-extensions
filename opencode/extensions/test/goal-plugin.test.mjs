import assert from "node:assert/strict"
import test from "node:test"
import { registerGoal } from "../src/goal.ts"

function harness(events = []) {
  const values = new Map()
  const commands = new Map()
  const tools = new Map()
  const calls = { prompt: [], synthetic: [], interrupt: [] }
  const ctx = {
    storage: {
      get: async (key) => values.get(key),
      set: async (key, value) => values.set(key, structuredClone(value)),
      remove: async (key) => values.delete(key),
    },
    event: { subscribe: async function* ({ signal }) { if (signal.aborted) return; yield* events } },
    session: {
      hook: async (name, handler) => { assert.equal(name, "context"); ctx.contextHook = handler },
      interrupt: async (input) => calls.interrupt.push(input),
      prompt: async (input) => calls.prompt.push(input),
      synthetic: async (input) => calls.synthetic.push(input),
    },
    tool: { transform: async (register) => register({ add: (tool) => tools.set(tool.name, tool) }) },
    command: { transform: async (register) => register({ add: (command) => commands.set(command.name, command) }) },
  }
  return { ctx, values, commands, tools, calls }
}

test("goal informational and stop commands never resume the host model", async () => {
  const app = harness()
  const cleanup = await registerGoal(app.ctx)
  await app.commands.get("goal").execute({ sessionID: "s1", prompt: { text: "/goal status" } })
  assert.equal(app.calls.prompt.length, 0)
  assert.equal(app.calls.synthetic[0].resume, false)
  await app.commands.get("goal").execute({ sessionID: "s1", prompt: { text: "/goal stop" } })
  assert.equal(app.calls.prompt.length, 0)
  assert.equal(app.calls.synthetic[1].resume, false)
  cleanup()
})

test("goal parses lifecycle commands instead of replacing the objective", async () => {
  const app = harness()
  const cleanup = await registerGoal(app.ctx)
  const command = app.commands.get("goal")
  await command.execute({ sessionID: "s1", prompt: { text: "/goal work on the feature" } })
  assert.equal(app.calls.prompt.length, 1)
  const active = app.values.get("workflow/goal/s1")
  assert.equal(active.objective, "work on the feature")
  assert.equal(active.status, "active")
  await command.execute({ sessionID: "s1", prompt: { text: "/goal pause" } })
  assert.equal(app.values.get("workflow/goal/s1").objective, "work on the feature")
  assert.equal(app.values.get("workflow/goal/s1").status, "paused")
  assert.deepEqual(app.calls.interrupt, [{ sessionID: "s1" }])
  await command.execute({ sessionID: "s1", prompt: { text: "/goal resume" } })
  assert.equal(app.values.get("workflow/goal/s1").status, "active")
  assert.equal(app.calls.prompt.length, 2)
  const before = app.values.get("workflow/goal/s1")
  await command.execute({ sessionID: "s1", prompt: { text: "/goal add new queued objective" } })
  assert.equal(app.values.get("workflow/goal/s1").id, before.id)
  assert.equal(app.values.get("workflow/goal/s1").objective, before.objective)
  assert.equal(app.calls.synthetic.at(-1).resume, false)
  cleanup()
})

test("goal helper tools require the exact active ID and concrete evidence", async () => {
  const app = harness()
  const cleanup = await registerGoal(app.ctx)
  await app.commands.get("goal").execute({ sessionID: "s1", prompt: { text: "/goal verify the change" } })
  const goal = app.values.get("workflow/goal/s1")
  const complete = app.tools.get("goal_complete")
  const stale = await complete.execute({ goal_id: "old", summary: "Done", evidence: ["test passed"] }, { sessionID: "s1" })
  assert.match(stale.content, /exact active goal/)
  const done = await complete.execute({ goal_id: goal.id, summary: "Implemented", evidence: ["npm test passed"] }, { sessionID: "s1" })
  assert.match(done.content, /completed/)
  assert.equal(app.values.get("workflow/goal/s1").status, "complete")
  cleanup()
})

test("goal token budgets and automatic turn limits consume host step events once", async () => {
  const event = { id: "event-a", type: "session.step.ended", created: 200, data: { sessionID: "s1", tokens: { input: 4, output: 5, reasoning: 1, cache: { read: 2, write: 0 } } } }
  const app = harness([event, event])
  const cleanup = await registerGoal(app.ctx)
  await app.commands.get("goal").execute({ sessionID: "s1", prompt: { text: "/goal --tokens 10k count usage" } })
  await new Promise((resolve) => setImmediate(resolve))
  const goal = app.values.get("workflow/goal/s1")
  assert.equal(goal.tokensUsed, 10)
  assert.equal(goal.automaticTurns, 1)
  assert.deepEqual(goal.usageEventIDs, ["event-a"])
  cleanup()
})
