import assert from "node:assert/strict"
import test from "node:test"
import tuiEntry from "../tui.js"
import exportedTuiEntry from "@romm0109/opencode-extensions/tui"
import { cacheOverview, createTuiPlugin, progressOverview, safeTuiText, stampOverview } from "../src/tui.ts"
import { BUILT_IN_STARSHIP_TEMPLATE, STATUS_PRESETS, createShowcaseState, fitCells, parseStarshipToml, renderStarship, renderStatusline, visibleCells } from "../src/terminal-presentation.ts"
import { STARSHIP_PRESETS } from "../src/starship-presets.ts"

function treeText(node) {
  if (node === null || node === undefined) return ""
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(treeText).join("\n")
  return [treeText(node.props?.children)].filter(Boolean).join("\n")
}

function harness() {
  const slots = []
  const opened = []
  const closed = []
  let layer
  const session = {
    id: "ses_fixture",
    title: "Fixture session",
    cost: 0.0123,
    model: { providerID: "fixture", modelID: "test-model" },
    tokens: { input: 100, output: 24, reasoning: 0, cache: { read: 80, write: 20 } },
  }
  let messages = [
    { id: "u1", type: "user", time: { created: 1000 }, text: "hello" },
    {
      id: "a1",
      type: "assistant",
      model: { providerID: "fixture", modelID: "test-model" },
      time: { created: 1100, completed: 3100 },
      tokens: { input: 100, output: 24, reasoning: 0, cache: { read: 80, write: 20 } },
      content: [
        { type: "tool", id: "tool_1", name: "update_progress", state: { status: "completed", input: { steps: [ { text: "Inspect", status: "completed" }, { text: "Build", status: "in_progress" } ] } } },
        { type: "tool", id: "tool_2", name: "search", state: { status: "completed", input: {} } },
      ],
    },
  ]
  const memory = new Map()
  const alerts = []
  const context = {
    renderer: { width: 80, requestRender() {} },
    storage: { memory: (key, options) => {
      const state = memory.get(key) ?? structuredClone(options.initial)
      memory.set(key, state)
      return [state, async (update) => update(state)]
    }, store: (key, options) => {
      const state = memory.get(key) ?? structuredClone(options.initial)
      memory.set(key, state)
      return [state, async (update) => update(state)]
    } },
    ui: {
      dialog: { alert: async (value) => alerts.push(value), prompt: async () => undefined, select: async () => undefined },
      slot: (claim) => { slots.push(claim); return () => { const index = slots.indexOf(claim); if (index >= 0) slots.splice(index, 1) } },
      panel: { open: (name) => { opened.push(name); return true }, close() { closed.push(true) }, current() {} },
      router: { current: () => ({ type: "session", sessionID: session.id }), register() {}, navigate() {} },
      tabs: { list: () => [], enabled: () => false, open: () => false, focus: () => false, move: () => false, close: () => false },
      model: { current: () => ({ providerID: "fixture", modelID: "test-model" }), variant: { list: () => [], set: () => true } },
    },
    data: {
      location: { vcs: { info: () => ({ branch: { name: "main" } }) } },
      session: {
        get: () => session,
        status: () => "idle",
        message: { list: () => messages },
        list: () => [session], root: () => "/tmp", family: () => [session.id], cost: () => session.cost,
        pending: { list: () => [], sync: async () => {}, invalidate() {} },
        sync: async () => {}, invalidate() {}, permission: { list: () => [], sync: async () => {}, invalidate() {} },
        form: { list: () => [], sync: async () => {}, invalidate() {}, reply: async () => {}, cancel: async () => {} },
      },
      on: () => () => {}, listen: () => () => {},
    },
    keymap: { layer: (factory) => { layer = factory }, dispatch() {}, shortcuts: () => [], commands: () => [], pending: () => [], active: () => [], mode: { current: () => "base", push: () => () => {} } },
  }
  const loadJSX = async () => ({ jsx: (type, props) => ({ type, props }) })
  return { context, slots, opened, closed, alerts, getLayer: () => layer, setMessages: (next) => { messages = next }, plugin: createTuiPlugin({ loadJSX }) }
}

test("cache overview only reports providers with observed cache activity", () => {
  const result = cacheOverview([
    { type: "assistant", model: { providerID: "one" }, tokens: { input: 20, cache: { read: 0, write: 0 } } },
    { type: "assistant", model: { providerID: "one" }, tokens: { input: 20, cache: { read: 60, write: 20 } } },
    { type: "assistant", model: { providerID: "other" }, tokens: { input: 40, cache: { read: 0, write: 0 } } },
  ])
  assert.equal(result.providerCount, 1)
  assert.equal(result.requests, 2)
  assert.equal(result.latestHitPercent, 60)
  assert.equal(result.sessionHitPercent, 50)
  assert.equal(cacheOverview([]).sessionHitPercent, null)
})

test("progress and stamp summaries use v2 transcript message and tool data", () => {
  const fixture = [
    { type: "assistant", time: { created: 1000, completed: 4200 }, content: [
      { type: "tool", name: "update_progress", state: { status: "completed", input: { steps: [{ text: "Inspect", status: "completed" }, { text: "Implement", status: "in_progress" }] } } },
      { type: "tool", name: "test", state: { status: "completed", input: {} } },
    ] },
  ]
  assert.deepEqual(progressOverview(fixture), { steps: [{ text: "Inspect", status: "completed" }, { text: "Implement", status: "in_progress" }], completed: 1 })
  assert.deepEqual(stampOverview(fixture), { responseMs: 3200, completedAt: 4200, toolCount: 2 })
})

test("progress follows the active branch and validates the server tool contract", () => {
  const toolMessage = (steps) => ({ type: "assistant", content: [
    { type: "tool", name: "update_progress", state: { status: "completed", input: { steps } } },
  ] })
  const original = toolMessage([{ text: "Old branch", status: "in_progress" }])
  const newBranch = toolMessage([{ text: "Fork work", status: "pending" }])
  assert.match(progressOverview([newBranch]).steps[0].text, /Fork work/)
  assert.equal(progressOverview([]), undefined)
  assert.equal(progressOverview([original, toolMessage([])]), undefined, "an empty checklist clears prior progress")
  assert.equal(progressOverview([toolMessage([{ text: "a", status: "in_progress" }, { text: "b", status: "in_progress" }])]), undefined)
  assert.equal(progressOverview([toolMessage([{ text: "bad status", status: "done" }])]), undefined)
  assert.equal(progressOverview([toolMessage(Array.from({ length: 51 }, (_, i) => ({ text: `${i}`, status: "pending" })))]), undefined)
  const compactedBranch = [{ type: "compaction", summary: "progress steps removed from this branch" }]
  assert.equal(progressOverview(compactedBranch), undefined, "compaction data without a verified checklist does not resurrect stale state")
})

test("TUI plugin registers native slots, slash commands, and session panels", async () => {
  assert.equal(tuiEntry.id, "romm0109.workflow.tui", "the package-level TUI forwarder exposes its plugin")
  assert.equal(exportedTuiEntry.id, tuiEntry.id, "the package export resolves the same CLI plugin entry")
  const app = harness()
  const cleanup = await app.plugin.setup(app.context)
  assert.deepEqual(app.slots.map((claim) => claim.replace ?? claim.append), ["prompt.footer", "home.footer.status", "session.panel"])
  const commands = app.getLayer()().commands
  assert.deepEqual(commands.map((command) => command.slash.name), ["workflow", "cache-hit-monitor", "stamp", "tui-kit-showcase", "footer-mode", "statusline-preset", "statusline", "starship-template", "starship-preset"])
  commands[0].run()
  assert.equal(app.opened[0], "romm0109-workflow")
  const footer = app.slots[0].render({ sessionID: "ses_fixture", mode: "normal", showDetails: false })
  assert.match(treeText(footer), /Fixture session/)
  const progress = app.slots[2].render({ name: "romm0109-workflow", sessionID: "ses_fixture", width: 80, presentation: "panel", focused: true, focus() {}, close() {}, toggleFullscreen() {} })
  assert.match(treeText(progress), /Checklist: 1\/2 complete/)
  assert.match(treeText(progress), /Build/)
  app.setMessages([])
  const reverted = app.slots[2].render({ name: "romm0109-workflow", sessionID: "ses_fixture", width: 80, presentation: "panel", focused: true, focus() {}, close() {}, toggleFullscreen() {} })
  assert.match(treeText(reverted), /no update_progress result/)
  assert.doesNotMatch(treeText(reverted), /Build/)
  app.setMessages([{ type: "assistant", content: [{ type: "tool", name: "update_progress", state: { status: "completed", input: { steps: [{ text: "Fork branch", status: "in_progress" }] } } }] }])
  const forked = app.slots[2].render({ name: "romm0109-workflow", sessionID: "ses_fixture", width: 80, presentation: "panel", focused: true, focus() {}, close() {}, toggleFullscreen() {} })
  assert.match(treeText(forked), /Fork branch/)
  const cache = app.slots[2].render({ name: "romm0109-cache", sessionID: "ses_fixture", width: 80, presentation: "panel", focused: true, focus() {}, close() {}, toggleFullscreen() {} })
  assert.match(treeText(cache), /Latest hit rate: unknown/)
  await commands.find((command) => command.slash.name === "footer-mode").run("starship")
  await commands.find((command) => command.slash.name === "starship-preset").run("minimal")
  assert.match(treeText(app.slots[0].render({ sessionID: "ses_fixture", mode: "normal", showDetails: false })), /test-model/u)
  await commands.find((command) => command.slash.name === "footer-mode").run("off trailing")
  assert.match(treeText(app.slots[0].render({ sessionID: "ses_fixture", mode: "normal", showDetails: false })), /test-model/u)
  assert.equal(app.alerts.length, 1)
  await commands.find((command) => command.slash.name === "footer-mode").run("off")
  assert.equal(treeText(app.slots[0].render({ sessionID: "ses_fixture", mode: "normal", showDetails: false })), "")
  await cleanup()
  assert.equal(app.slots.length, 0)
  assert.equal(app.closed.length, 1)
})

test("native presentation has mutually exclusive footer modes and narrow-cell layout", () => {
  const data = { status: "running", model: "fixture-model", provider: "fixture", root: "/tmp/very-long-workspace-name", branch: "feature/demo", input: 12000, output: 300 }
  assert.deepEqual(STATUS_PRESETS.minimal, ["model", "cwd", "branch"])
  assert.match(renderStatusline(data, "verbose", 31), /…$/u)
  assert.ok(visibleCells(renderStatusline(data, "verbose", 31)) <= 31)
  assert.equal(visibleCells(fitCells("東京 abc", 5)), 5)
  const config = parseStarshipToml('format = "[$brand]($style) $model\\\\n$directory"\n\npalette = "tokyo-night"\n[palettes.tokyo-night]\nblue = "#123456"\n[model]\nsymbol = "M:"\n')
  assert.equal(config.palette, "tokyo-night")
  assert.equal(config.modules.model.symbol, "M:")
  assert.match(renderStarship(config, data, 45), /M:fixture-model/u)
  assert.equal(parseStarshipToml(`format = "${BUILT_IN_STARSHIP_TEMPLATE}"`).format, BUILT_IN_STARSHIP_TEMPLATE)
  assert.throws(() => parseStarshipToml("unknown = true"), /Unknown module/u)
  for (const preset of Object.values(STARSHIP_PRESETS)) {
    const parsed = parseStarshipToml(preset)
    assert.equal(typeof parsed.format, "string")
    for (const width of [18, 40, 120]) assert.ok(renderStarship(parsed, data, width).split("\n").every((line) => visibleCells(line) <= width))
  }
})

test("showcase state examples distinguish busy, selection, input, confirmation, search, and cancellation", () => {
  const state = createShowcaseState()
  assert.equal(state.page, "menu")
  state.page = "busy"
  state.busy = true
  assert.equal(state.busy, true)
  state.page = "input"
  state.input = "draft"
  assert.equal(state.input, "draft")
  state.page = "confirm"
  assert.equal(state.page, "confirm")
  state.page = "search"
  state.query = "disabled"
  assert.equal(state.query, "disabled")
  state.page = "menu"
  state.message = "Cancelled; no demo state was saved."
  assert.match(state.message, /Cancelled/u)
})

test("showcase panel processes actions, busy cancel, selection, input, confirm, search, and escape", async () => {
  const app = harness()
  const cleanup = await app.plugin.setup(app.context)
  const panel = app.slots[2].render({ name: "romm0109-tui-showcase", sessionID: "ses_fixture", width: 80, presentation: "panel", focused: true, focus() {}, close() {}, toggleFullscreen() {} })
  const key = (name, sequence) => panel.props.onKeyDown({ name, sequence })
  key("ENTER")
  key("DOWN")
  key("ENTER")
  let updated = app.slots[2].render({ name: "romm0109-tui-showcase", sessionID: "ses_fixture", width: 80, presentation: "panel", focused: true, focus() {}, close() {}, toggleFullscreen() {} })
  assert.match(treeText(updated), /Disabled action is unavailable/u)
  key("ESC")
  key("ENTER")
  updated = app.slots[2].render({ name: "romm0109-tui-showcase", sessionID: "ses_fixture", width: 80, presentation: "panel", focused: true, focus() {}, close() {}, toggleFullscreen() {} })
  assert.match(treeText(updated), /Busy example/u)
  key("ESC")
  for (let index = 0; index < 4; index += 1) key("DOWN")
  key("ENTER")
  for (const char of "busy") key(char, char)
  key("ENTER")
  updated = app.slots[2].render({ name: "romm0109-tui-showcase", sessionID: "ses_fixture", width: 80, presentation: "panel", focused: true, focus() {}, close() {}, toggleFullscreen() {} })
  assert.match(treeText(updated), /Search matched 1 examples/u)
  key("UP")
  key("ENTER")
  key("y")
  updated = app.slots[2].render({ name: "romm0109-tui-showcase", sessionID: "ses_fixture", width: 80, presentation: "panel", focused: true, focus() {}, close() {}, toggleFullscreen() {} })
  assert.match(treeText(updated), /Confirmed in memory/u)
  for (let index = 0; index < 5; index += 1) key("DOWN")
  key("ENTER")
  key("DOWN")
  key("ENTER")
  key("DOWN")
  key("ENTER")
  updated = app.slots[2].render({ name: "romm0109-tui-showcase", sessionID: "ses_fixture", width: 80, presentation: "panel", focused: true, focus() {}, close() {}, toggleFullscreen() {} })
  assert.match(treeText(updated), /Selected profile: Verbose/u)
  key("x", "x")
  key("ENTER")
  updated = app.slots[2].render({ name: "romm0109-tui-showcase", sessionID: "ses_fixture", width: 80, presentation: "panel", focused: true, focus() {}, close() {}, toggleFullscreen() {} })
  assert.match(treeText(updated), /Input accepted: x/u)
  key("DOWN")
  key("ENTER")
  key("ESC")
  updated = app.slots[2].render({ name: "romm0109-tui-showcase", sessionID: "ses_fixture", width: 80, presentation: "panel", focused: true, focus() {}, close() {}, toggleFullscreen() {} })
  assert.match(treeText(updated), /Cancelled; no demo state was saved/u)
  await cleanup()
  assert.equal(app.slots.length, 0)
  assert.equal(app.closed.length, 1)
})

test("terminal control sequences are removed from user text", () => {
  assert.equal(safeTuiText("\u001b[31munsafe\u001b[0m\nnext"), "unsafe next")
  assert.equal(safeTuiText("👨‍👩‍👧‍👦x", 1), "👨‍👩‍👧‍👦")
})
