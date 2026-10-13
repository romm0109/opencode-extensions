import type { PluginContext } from "../plugin-types.ts"
import { SessionJobRegistry } from "./coordination.ts"

/** OpenCode has no public prompt-editor insertion API; bring-back is an explicit session message. */
export function registerBtw(ctx: PluginContext, jobs: SessionJobRegistry): Promise<void> {
  return ctx.command.transform((editor) => editor.add({
    name: "btw",
    description: "Ask an isolated side question, or bring a completed side-session answer into this transcript.",
    execute: async ({ sessionID, prompt }) => {
      const input = prompt.text.trim().replace(/^\/btw\s*/i, "")
      const bring = /^bring\s+(\S+)$/i.exec(input)
      if (bring) {
        const answer = await jobs.bringBack(sessionID, bring[1]!)
        await ctx.session.synthetic({ sessionID, text: `Side answer brought back (${Buffer.byteLength(answer, "utf8")} bytes).`, resume: false })
        return
      }
      if (!input) {
        await ctx.session.synthetic({ sessionID, text: "Usage: /btw <side question> or /btw bring <job-id>. Side questions run in a child session; bring-back appends the answer as a synthetic transcript message because OpenCode v2 exposes no editor insertion API.", resume: false })
        return
      }
      const job = await jobs.spawn(sessionID, input, `btw: ${input.slice(0, 80)}`)
      await ctx.session.synthetic({
        sessionID,
        text: `Started isolated side session ${job.childSessionID} (job ${job.id}). Its question and answer stay in that child transcript. When it finishes, use /btw bring ${job.id} to append the answer here.`,
        resume: false,
      })
      // The child runs only after this explicit user command; completion is collected by
      // subagent_wait or /btw bring.
    },
  })).then(() => undefined)
}
