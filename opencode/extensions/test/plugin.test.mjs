import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../src/index.ts"

function harness() {
  const values = new Map()
  const tools = []
  const commands = new Map()
  let contextHook
  const sessionHooks = new Map()
  const permissionHooks = new Map()
  const hooks = new Map()
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
    permission: { hook: async (name, callback) => permissionHooks.set(name, callback) },
    event: { subscribe: async function* () { await new Promise(() => {}) } },
    agent: { get: (id) => ({ id }), list: () => [] },
    session: {
      hook: async (name, callback) => { sessionHooks.set(name, callback); if (name === "context") contextHook = callback },
      synthetic: async ({ sessionID, text }) => values.set(`synthetic/${sessionID}`, text),
      prompt: async ({ sessionID, text }) => values.set(`prompt/${sessionID}`, text),
      get: async ({ sessionID }) => ({ id: sessionID, agent: "build" }),
      switchAgent: async ({ sessionID, agent }) => values.set(`agent/${sessionID}`, agent),
      interrupt: async () => {},
    },
    command: {
      transform: async (register) => register({ add: (command) => commands.set(command.name, command) }),
    },
  }
  return { context, values, tools, commands, getContextHook: () => contextHook, getPermissionHook: () => permissionHooks.get("evaluate") }
}

test("goal state and context are isolated per session", async () => {
  const app = harness()
  await plugin.setup(app.context)
  const goal = app.commands.get("goal")
  await goal.execute({ sessionID: "s1", prompt: { text: "/goal ship the feature" }, delivery: "steer" })
  assert.match(app.values.get("prompt/s1"), /ship the feature/)

  const first = { sessionID: "s1", system: [], messages: [], options: {}, tools: {}, model: {}, agent: "build" }
  const second = { ...first, sessionID: "s2", system: [] }
  await app.getContextHook()(first)
  await app.getContextHook()(second)
  assert.equal(first.system.length, 0)
  assert.equal(second.system.length, 0)
})

test("progress tool validates and stores a session checklist", async () => {
  const app = harness()
  await plugin.setup(app.context)
  const tool = app.tools.find((entry) => entry.name === "update_progress")
  const ok = await tool.execute({ steps: [{ text: "Inspect", status: "completed" }, { text: "Implement", status: "in_progress" }] }, { sessionID: "s1" })
  assert.match(ok.content, /\[x\] Inspect/)
  assert.match(ok.content, /\[~\] Implement/)
  assert.equal(app.values.has("session/progress/s1"), false)
  const bad = await tool.execute({ steps: [{ text: "a", status: "in_progress" }, { text: "b", status: "in_progress" }] }, { sessionID: "s1" })
  assert.match(bad.content, /at most one in_progress/)
  assert.equal((await tool.execute({ steps: [] }, { sessionID: "s1" })).content, "Progress cleared for this session.")
  assert.equal(app.values.has("session/progress/s1"), false)
})

test("progress accepts 50 steps and limits text by grapheme clusters", async () => {
  const app = harness()
  await plugin.setup(app.context)
  const tool = app.tools.find((entry) => entry.name === "update_progress")
  const ok = await tool.execute({ steps: Array.from({ length: 50 }, (_, i) => ({ text: `step ${i}`, status: "pending" })) }, { sessionID: "s1" })
  assert.match(ok.content, /step 49/)
  const tooLong = await tool.execute({ steps: [{ text: "👨‍👩‍👧‍👦".repeat(504), status: "pending" }] }, { sessionID: "s1" })
  assert.match(tooLong.content, /up to 503 graphemes/)
})

test("plan review is enforced read-only until explicit approval and handoff", async () => {
  const app = harness()
  await plugin.setup(app.context)
  const plan = app.commands.get("plan")
  await plan.execute({ sessionID: "s1", prompt: { text: "/plan inspect the release process" }, delivery: "steer" })
  assert.match(app.values.get("prompt/s1"), /inspect the release process/)
  const permission = { sessionID: "s1", action: "write", resources: [], effect: "ask" }
  await app.getPermissionHook()(permission)
  assert.equal(permission.effect, "deny")
  await plan.execute({ sessionID: "s1", prompt: { text: "/plan exit" }, delivery: "steer" })
  assert.equal(app.values.has("workflow/plan/s1"), false)
})
