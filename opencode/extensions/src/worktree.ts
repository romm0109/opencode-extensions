import { basename, dirname, resolve } from "node:path"
import type { PluginContext } from "./plugin-types.ts"

export async function registerWorktreeCommands(context: PluginContext): Promise<void> {
  await context.command.transform((editor) => {
    editor.add({
      name: "worktree",
      description: "List, create, or remove OpenCode Git worktrees",
      execute: async ({ sessionID, prompt }) => {
        const args = prompt.text.replace(/^\/worktree\s*/i, "").trim()
        const [action = "list", ...parts] = splitArguments(args)
        const projectID = context.location.project.id
        if (action === "list" && parts.length === 0) {
          const entries = await context.worktree.list({ projectID })
          const text = entries.length
            ? `Project worktrees:\n${entries.map((entry) => `- ${entry.directory}${entry.strategy ? ` (${entry.strategy})` : ""}`).join("\n")}`
            : "No worktrees are registered for this project."
          await context.session.synthetic({ sessionID, text, resume: false })
          return
        }
        if (action === "add" && (parts.length === 1 || parts.length === 2)) {
          const [branch, target] = parts
          if (!branch) throw new Error("Usage: /worktree add <branch> [absolute-destination]")
          const directory = target
            ? resolve(context.location.directory, target)
            : resolve(dirname(context.location.directory), `${basename(context.location.directory)}-${branch.replaceAll("/", "-")}`)
          const created = await context.worktree.create({ projectID, branch, directory })
          await context.session.synthetic({ sessionID, text: `Created worktree at ${created.directory}.`, resume: false })
          return
        }
        if (action === "remove" && parts.length === 1) {
          const directory = resolve(context.location.directory, parts[0]!)
          await context.worktree.remove({ projectID, directory, force: false })
          await context.session.synthetic({ sessionID, text: `Removed worktree at ${directory}.`, resume: false })
          return
        }
        throw new Error("Usage: /worktree [list | add <branch> [absolute-destination] | remove <path>]")
      },
    })
  })
}

function splitArguments(value: string): string[] {
  const result: string[] = []
  const matcher = /(?:"([^"]*)"|'([^']*)'|(\S+))/g
  for (const match of value.matchAll(matcher)) result.push(match[1] ?? match[2] ?? match[3] ?? "")
  return result
}
