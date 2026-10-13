import assert from "node:assert/strict"
import test from "node:test"
import { registerCoordinationGroup } from "../../src/coordination/index.ts"
import { createCoordinationTui } from "../../src/coordination/tui.ts"

test("server registration installs four coordination commands and seven tools", async () => {
  const commands = new Map()
  const tools = new Map()
  const values = new Map()
  let eventSignal
  const ctx = {
    session: {
      async create() { return { id: "child", agent: "build" } },
      async get({ sessionID }) { return { id: sessionID, agent: "build" } },
      async prompt() {}, async wait() {}, async interrupt() {}, async remove() {}, async context() { return [] }, async synthetic() {},
    },
    storage: { async get(key) { return values.get(key) }, async set(key, value) { values.set(key, value) }, async remove(key) { values.delete(key) } },
    command: { async transform(register) { register({ add: (item) => commands.set(item.name, item) }); return {} } },
    tool: { async transform(register) { register({ add: (item) => tools.set(item.name, item) }); return {} } },
    event: { async *subscribe({ signal }) { eventSignal = signal; await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })) } },
  }
  const cleanup = await registerCoordinationGroup(ctx)
  assert.deepEqual([...commands.keys()].sort(), ["btw", "fleet", "herdr", "subagents"])
  assert.deepEqual([...tools.keys()].sort(), ["herdr_agents", "subagent_cancel", "subagent_inspect", "subagent_respond", "subagent_send", "subagent_spawn", "subagent_wait"])
  await cleanup()
  assert.equal(eventSignal.aborted, true)
})

test("TUI module exposes native child panel, tab open, and explicit bring-back controls", async () => {
  const slots = []
  let keymap
  const opened = []
  const synthetic = []
  const jsx = { jsx: (type, props) => ({ type, props }) }
  const ctx = {
    ui: {
      slot: (claim) => slots.push(claim),
      panel: { open() {} },
      tabs: { list: () => [{ sessionID: "parent", active: true }], open: (id) => opened.push(id) },
      router: { current: () => ({ type: "session", sessionID: "parent" }) },
      keymap: undefined,
    },
    keymap: { layer: (factory) => { keymap = factory() } },
    data: {
      session: {
        family: () => ["parent", "child"],
        get: (id) => ({ id, title: "side answer" }),
        status: () => "idle",
        message: { list: () => [{ type: "assistant", content: [{ type: "text", text: "answer" }] }] },
      },
    },
    client: { session: { synthetic: async (value) => synthetic.push(value) } },
  }
  await createCoordinationTui({ loadJSX: async () => jsx }).setup(ctx)
  assert.equal(slots.length, 1)
  const panel = slots[0].render({ name: "romm0109-coordination", sessionID: "parent" })
  assert.equal(panel.type, "box")
  const commands = new Map(keymap.commands.map((entry) => [entry.id, entry]))
  commands.get("romm0109.coordination.open").run("child")
  assert.deepEqual(opened, ["child"])
  await commands.get("romm0109.coordination.bring").run("child")
  assert.equal(synthetic[0].sessionID, "parent")
  assert.match(synthetic[0].text, /answer/)
})
