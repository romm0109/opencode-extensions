import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../src/index.ts"

function harness() {
  const values = new Map()
  const tools = []
  const commands = new Map()
  let contextHook
  const context = {
    app: { version: "2.0.28" },
    location: { project: { id: "project-test" } },
    options: {},
    storage: {
      get: async (key) => values.get(key),
      set: async (key, value) => values.set(key, value),
      remove: async (key) => values.delete(key),
    },
    tool: { transform: async (register) => register({ add: (tool) => tools.push(tool) }) },
    session: {
      hook: async (name, callback) => {
        assert.equal(name, "context")
        contextHook = callback
      },
      synthetic: async ({ sessionID, text }) => values.set(`synthetic/${sessionID}`, text),
    },
    command: {
      transform: async (register) => register({ add: (command) => commands.set(command.name, command) }),
    },
  }
  return { context, values, tools, commands, getContextHook: () => contextHook }
}

test("goal state and context are isolated per session", async () => {
  const app = harness()
  await plugin.setup(app.context)
  const goal = app.commands.get("goal")
  await goal.execute({ sessionID: "s1", prompt: { text: "/goal ship the feature" }, delivery: "steer" })
  assert.equal(app.values.get("synthetic/s1"), "Goal set: ship the feature")

  const first = { sessionID: "s1", system: [], messages: [], options: {}, tools: {}, model: {}, agent: "build" }
  const second = { ...first, sessionID: "s2", system: [] }
  await app.getContextHook()(first)
  await app.getContextHook()(second)
  assert.match(first.system[0].text, /ship the feature/)
  assert.equal(second.system.length, 0)
})

test("progress tool validates and stores a session checklist", async () => {
  const app = harness()
  await plugin.setup(app.context)
  const tool = app.tools.find((entry) => entry.name === "update_progress")
  const ok = await tool.execute({ steps: [{ text: "Inspect", done: true }, { text: "Implement", done: false }] }, { sessionID: "s1" })
  assert.match(ok.content, /\[x\] Inspect/)
  assert.deepEqual(app.values.get("session/progress/s1"), [
    { text: "Inspect", done: true },
    { text: "Implement", done: false },
  ])
  const bad = await tool.execute({ steps: [] }, { sessionID: "s1" })
  assert.match(bad.content, /Progress was not changed/)
})

test("plan toggle is explicitly advisory", async () => {
  const app = harness()
  await plugin.setup(app.context)
  const plan = app.commands.get("plan")
  await plan.execute({ sessionID: "s1", prompt: { text: "/plan on" }, delivery: "steer" })
  const request = { sessionID: "s1", system: [], messages: [], options: {}, tools: {}, model: {}, agent: "build" }
  await app.getContextHook()(request)
  assert.match(request.system[0].text, /without modifying files or running mutating tools/)
  assert.match(app.values.get("synthetic/s1"), /does not enforce tool permissions/)
})
