import assert from "node:assert/strict"
import test from "node:test"
import { createNotesService, createRecallService, registerNotesRecall } from "../src/notes-recall.ts"

function memoryStore(initial = new Map()) {
  return {
    values: initial,
    async get(key) { return this.values.get(key) },
    async set(key, value) { this.values.set(key, structuredClone(value)) },
    async remove(key) { this.values.delete(key) },
  }
}

test("notes support bounded CRUD and leave malformed data unchanged", async () => {
  const storage = memoryStore()
  let id = 0
  let now = 100
  const notes = createNotesService(storage, { createID: () => `note-${++id}`, now: () => now++ })
  const note = await notes.create("  Idea  ", "first draft")
  assert.equal(note.title, "Idea")
  assert.equal((await notes.get(note.id)).body, "first draft")
  const updated = await notes.update(note.id, { body: "revised" })
  assert.equal(updated.body, "revised")
  assert.equal(await notes.delete(note.id), true)
  assert.deepEqual(await notes.list(), [])

  storage.values.set("data/notes", [{ broken: true }])
  await assert.rejects(notes.create("Another"), /malformed/)
  assert.deepEqual(storage.values.get("data/notes"), [{ broken: true }])
})

test("recall saves local message records, filters, quotes and deletes", async () => {
  const storage = memoryStore()
  const recall = createRecallService(storage, { createID: () => "saved-1", now: () => 200 })
  const record = await recall.save({
    role: "assistant", text: "Keep this answer", sourceSessionID: "session-a",
    sourceMessageID: "message-a", cwd: "/repo", sessionName: "Feature", timestamp: 123,
  })
  assert.equal((await recall.list({ cwd: "/repo", query: "feature" })).length, 1)
  assert.equal((await recall.list({ sessionID: "session-b" })).length, 0)
  assert.match(recall.quote(record), /<recalled_message role="assistant"/)
  await assert.rejects(recall.save({ ...record }), /already been saved/)
  assert.equal(await recall.delete(record.id), true)
  assert.equal((await recall.list()).length, 0)
})

test("registration exposes notes and recall tools plus server commands", async () => {
  const storage = memoryStore()
  const tools = new Map()
  const commands = new Map()
  const synthetic = []
  const host = {
    storage: {
      get: storage.get.bind(storage),
      set: storage.set.bind(storage),
      remove: storage.remove.bind(storage),
    },
    tool: { transform: async (fn) => fn({ add: (entry) => tools.set(entry.name, entry) }) },
    command: { transform: async (fn) => fn({ add: (entry) => commands.set(entry.name, entry) }) },
    session: { synthetic: async (entry) => synthetic.push(entry) },
  }
  await registerNotesRecall(host)
  for (const name of ["notes_list", "notes_create", "notes_read", "notes_update", "notes_delete", "recall_save", "recall_search", "recall_quote", "recall_delete"]) {
    assert.ok(tools.has(name), `missing ${name}`)
  }
  assert.ok(commands.has("notes"))
  assert.ok(commands.has("recall"))

  const create = await tools.get("notes_create").execute({ title: "Idea", body: "Draft" }, { sessionID: "s1" })
  const note = JSON.parse(create.content)
  assert.equal(note.body, "Draft")
  assert.equal(JSON.parse((await tools.get("notes_read").execute({ id: note.id }, { sessionID: "s1" })).content).title, "Idea")
  await tools.get("notes_update").execute({ id: note.id, body: "Updated" }, { sessionID: "s1" })
  assert.equal(JSON.parse((await tools.get("notes_read").execute({ id: note.id }, { sessionID: "s1" })).content).body, "Updated")
  assert.match((await tools.get("notes_delete").execute({ id: note.id }, { sessionID: "s1" })).content, /deleted/)

  const saved = await tools.get("recall_save").execute({
    role: "user", text: "Remember this", sourceMessageID: "m1", timestamp: 123,
  }, { sessionID: "s1" })
  const savedID = JSON.parse(saved.content).id
  const matches = await tools.get("recall_search").execute({ query: "remember" }, { sessionID: "s1" })
  assert.equal(JSON.parse(matches.content)[0].sourceSessionID, "s1")
  assert.match((await tools.get("recall_quote").execute({ id: savedID }, { sessionID: "s1" })).content, /<recalled_message/)
  assert.match((await tools.get("recall_delete").execute({ id: savedID }, { sessionID: "s1" })).content, /deleted/)

  await commands.get("notes").execute({ sessionID: "s1", prompt: { text: "/notes list" }, delivery: "steer" })
  assert.match(synthetic[0].text, /No notes saved/)
})
