import assert from "node:assert/strict"
import test from "node:test"
import { SessionJobRegistry } from "../../src/coordination/coordination.ts"
import { availableFleetTransports } from "../../src/coordination/fleet.ts"
import { parseHerdrAgentList, requestHerdrAgents } from "../../src/coordination/herdr.ts"

function fixture() {
  const values = new Map()
  const sessions = new Map([[
    "parent", { id: "parent", agent: "build", messages: [] },
  ]])
  const synthetic = []
  const interrupted = []
  let counter = 0
  const session = {
    async get({ sessionID }) {
      const value = sessions.get(sessionID)
      if (!value) throw new Error("missing session")
      return value
    },
    async create(input) {
      const id = `child-${++counter}`
      sessions.set(id, { id, agent: input.agent, parentID: input.parentID, title: input.title, messages: [] })
      return sessions.get(id)
    },
    async prompt({ sessionID, text }) {
      sessions.get(sessionID).messages.push({ type: "user", text })
    },
    async wait({ sessionID }) {
      sessions.get(sessionID).messages.push({ type: "assistant", content: [{ type: "text", text: "fixture answer" }] })
    },
    async context({ sessionID }) { return sessions.get(sessionID).messages },
    async interrupt({ sessionID }) { interrupted.push(sessionID) },
    async remove({ sessionID }) { sessions.delete(sessionID) },
    async synthetic(input) { synthetic.push(input) },
  }
  const storage = {
    async get(key) { return values.get(key) },
    async set(key, value) { values.set(key, value) },
    async remove(key) { values.delete(key) },
  }
  return { values, sessions, synthetic, interrupted, session, storage, jobs: new SessionJobRegistry(session, storage) }
}

test("subagent job sessions remain isolated and explicit bring-back targets the parent", async () => {
  const app = fixture()
  const job = await app.jobs.spawn("parent", "independent task", "Fixture")
  assert.equal(app.sessions.get(job.childSessionID).parentID, "parent")
  assert.equal(app.sessions.get(job.childSessionID).agent, "build")
  assert.deepEqual(app.sessions.get("parent").messages, [])
  assert.equal((await app.jobs.list("parent"))[0].status, "running")
  const answer = await app.jobs.bringBack("parent", job.id)
  assert.equal(answer, "fixture answer")
  assert.equal(app.synthetic.length, 1)
  assert.equal(app.synthetic[0].sessionID, "parent")
  assert.equal(app.synthetic[0].resume, false)
  assert.match(app.synthetic[0].text, /fixture answer/)
  await assert.rejects(app.jobs.send("another-parent", job.id, "message"), /belongs to this session/)
})

test("child messaging is request-response scoped and child cancellation is owned by parent", async () => {
  const app = fixture()
  const job = await app.jobs.spawn("parent", "task")
  const requestID = await app.jobs.sendFromChild(job.childSessionID, "need clarification")
  assert.match(app.synthetic[0].text, new RegExp(requestID))
  assert.equal(await app.jobs.respond("wrong-parent", requestID, "no"), false)
  assert.equal(await app.jobs.respond("parent", requestID, "continue"), true)
  assert.equal(await app.jobs.waitForResponse(job.childSessionID, requestID), "continue")
  assert.equal(await app.jobs.cancel("parent", job.id), true)
  assert.deepEqual(app.interrupted, [job.childSessionID])
  assert.equal((await app.jobs.list("parent"))[0].status, "cancelled")
})

test("cancelling a child wait preserves its unanswered request for a later wait", async () => {
  const app = fixture()
  const job = await app.jobs.spawn("parent", "task")
  const requestID = await app.jobs.sendFromChild(job.childSessionID, "question")
  const controller = new AbortController()
  const waiting = app.jobs.waitForResponse(job.childSessionID, requestID, controller.signal)
  controller.abort(new Error("caller stopped waiting"))
  await assert.rejects(waiting, /caller stopped waiting/)
  assert.equal(await app.jobs.respond("parent", requestID, "later answer"), true)
  assert.equal(await app.jobs.waitForResponse(job.childSessionID, requestID), "later answer")
  assert.equal(await app.jobs.respond("parent", requestID, "second answer"), false)
})

test("cancelling spawn interrupts and removes a child created for the cancelled request", async () => {
  const app = fixture()
  let promptStarted
  const ready = new Promise((resolve) => { promptStarted = resolve })
  app.session.prompt = async () => { promptStarted(); await new Promise(() => {}) }
  const controller = new AbortController()
  const spawning = app.jobs.spawn("parent", "cancel me", "fixture", controller.signal)
  await ready
  controller.abort(new Error("spawn cancelled"))
  await assert.rejects(spawning, /spawn cancelled/)
  assert.equal(app.sessions.has("child-1"), false)
  assert.deepEqual(app.interrupted, ["child-1"])
  assert.equal((await app.jobs.list("parent")).length, 0)
})

test("parent disposal interrupts and removes only its child sessions", async () => {
  const app = fixture()
  const first = await app.jobs.spawn("parent", "task")
  await app.jobs.disposeParent("parent")
  assert.equal(app.sessions.has(first.childSessionID), false)
  assert.equal(app.sessions.has("parent"), true)
  assert.equal(await app.jobs.list("parent").then((rows) => rows.length), 0)
})

test("concurrent job creation preserves every job record", async () => {
  const app = fixture()
  await Promise.all(Array.from({ length: 8 }, (_, index) => app.jobs.spawn("parent", `task ${index}`)))
  assert.equal((await app.jobs.list("parent")).length, 8)
})

test("parent and child ownership reconstructs from durable metadata after registry reload", async () => {
  const app = fixture()
  const job = await app.jobs.spawn("parent", "task")
  const replacementRegistry = new SessionJobRegistry(app.session, app.storage)
  assert.deepEqual(app.values.get("coordination/session-job-parents"), ["parent"])
  assert.equal(await replacementRegistry.childParent(job.childSessionID), "parent")
  await replacementRegistry.disposeChild(job.childSessionID)
  assert.equal((await replacementRegistry.list("parent")).length, 0)
  assert.deepEqual(app.values.get("coordination/session-job-parents"), [])
})

test("retention never discards a running child but prunes terminal records after the retention window", async () => {
  const app = fixture()
  await app.jobs.spawn("parent", "long-running")
  const key = "coordination/session-jobs/parent"
  const stored = app.values.get(key)
  stored.jobs[0].createdAt = Date.now() - 25 * 60 * 60 * 1_000
  app.values.set(key, stored)
  assert.equal((await app.jobs.list("parent")).length, 1)
  stored.jobs[0].status = "completed"
  app.values.set(key, stored)
  assert.equal((await app.jobs.list("parent")).length, 0)
  assert.deepEqual(app.values.get("coordination/session-job-parents"), [])
})

test("Herdr parser rejects malformed records and rejects non-local endpoints before connecting", async () => {
  assert.deepEqual(parseHerdrAgentList({ type: "agent_list", agents: [{ pane_id: "p1", workspace_id: "w1", agent_status: "working", title: "build" }] }), [
    { paneID: "p1", workspaceID: "w1", status: "working", title: "build" },
  ])
  assert.throws(() => parseHerdrAgentList({ type: "agent_list", agents: [{ pane_id: "p1" }] }), /invalid agent record/)
  await assert.rejects(requestHerdrAgents("tcp://127.0.0.1:12345"), /absolute local Unix socket path/)
})

test("Fleet transport detection requires the matching multiplexer identity and platform", () => {
  assert.deepEqual(availableFleetTransports({ TMUX: "socket", TMUX_PANE: "%12", ZELLIJ: "1", ZELLIJ_PANE_ID: "34", TERM_PROGRAM: "ghostty" }, "darwin"), ["tmux", "zellij", "ghostty"])
  assert.deepEqual(availableFleetTransports({ TMUX: "socket", TMUX_PANE: "bad", TERM_PROGRAM: "ghostty" }, "linux"), [])
})
