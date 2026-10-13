import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { formatFileQuote, readFileContext, registerFileContext } from "../src/file-context.ts"
import { registerToolCatalog } from "../src/tool-catalog.ts"
import { registerWorktreeCommands } from "../src/worktree.ts"

function harness(root) {
  const commands = new Map()
  const calls = { prompts: [], synthetic: [], worktree: [] }
  const context = {
    location: { directory: root, project: { id: "project-fixture" } },
    command: { transform: async (register) => register({ add: (command) => commands.set(command.name, command) }) },
    session: {
      prompt: async (input) => calls.prompts.push(input),
      synthetic: async (input) => calls.synthetic.push(input),
    },
    tool: { list: async () => [{ id: "grep", name: "grep", description: "Search text", input: { type: "object" }, options: {} }] },
    worktree: {
      list: async (input) => { calls.worktree.push(["list", input]); return [{ directory: "/tmp/project", strategy: "git" }] },
      create: async (input) => { calls.worktree.push(["create", input]); return { directory: input.directory } },
      remove: async (input) => { calls.worktree.push(["remove", input]) },
    },
  }
  return { context, commands, calls }
}

test("file-context reads only safe project files and formats bounded, exact line snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-file-context-"))
  try {
    await mkdir(path.join(root, "src"))
    await writeFile(path.join(root, "src", "sample.ts"), "one\ntwo\nthree\n")
    const quote = await readFileContext(root, "src/sample.ts", 2, 3)
    assert.deepEqual(quote, { path: "src/sample.ts", startLine: 2, endLine: 3, text: "two\nthree" })
    assert.equal(formatFileQuote(quote), '<user_file_quote path="src/sample.ts" lines="2-3">\ntwo\nthree\n</user_file_quote>')
    await assert.rejects(readFileContext(root, "../outside"), /outside the current project/)
    await assert.rejects(readFileContext(root, "src/sample.ts", 2, 50), /Line range/)
    const elsewhere = path.join(root, "elsewhere")
    await writeFile(elsewhere, "secret")
    await symlink(elsewhere, path.join(root, "linked"))
    await assert.rejects(readFileContext(root, "linked"), /Symbolic links are not accepted/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("/file-context injects the selected snapshot into the same session prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-file-command-"))
  try {
    await writeFile(path.join(root, "note.md"), "alpha\nbeta\n")
    const { context, commands, calls } = harness(root)
    await registerFileContext(context)
    await commands.get("file-context").execute({ sessionID: "session-fixture", prompt: { text: "/file-context note.md 2:2" } })
    assert.equal(calls.prompts.length, 1)
    assert.equal(calls.prompts[0].sessionID, "session-fixture")
    assert.match(calls.prompts[0].text, /lines="2-2">\nbeta/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("/tool reports registered schemas but does not mutate active tool availability", async () => {
  const { context, commands, calls } = harness("/tmp")
  await registerToolCatalog(context)
  await commands.get("tool").execute({ sessionID: "session-fixture", prompt: { text: "/tool grep" } })
  assert.equal(calls.synthetic.length, 1)
  assert.match(calls.synthetic[0].text, /Input schema:/)
  assert.equal(calls.synthetic[0].sessionID, "session-fixture")
})

test("/worktree delegates list, create, and non-force remove to the native host API", async () => {
  const root = "/tmp/project"
  const { context, commands, calls } = harness(root)
  await registerWorktreeCommands(context)
  await commands.get("worktree").execute({ sessionID: "s1", prompt: { text: "/worktree list" } })
  await commands.get("worktree").execute({ sessionID: "s1", prompt: { text: "/worktree add feature/ui" } })
  await commands.get("worktree").execute({ sessionID: "s1", prompt: { text: "/worktree remove feature-ui" } })
  assert.deepEqual(calls.worktree.map(([action]) => action), ["list", "create", "remove"])
  assert.equal(calls.worktree[0][1].projectID, "project-fixture")
  assert.equal(calls.worktree[1][1].branch, "feature/ui")
  assert.equal(calls.worktree[1][1].directory, "/tmp/project-feature-ui")
  assert.equal(calls.worktree[2][1].force, false)
  assert.ok(calls.synthetic.every((entry) => entry.sessionID === "s1"))
})
