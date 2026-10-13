import type { PluginContext } from "../plugin-types.ts"
import { SessionJobRegistry } from "./coordination.ts"

/** Describes the verified transport boundary without launching an unverified OpenCode CLI command. */
export type FleetTransport = "tmux" | "zellij" | "ghostty"
export type FleetTransportEnvironment = Readonly<Record<string, string | undefined>>

export function availableFleetTransports(env: FleetTransportEnvironment, platform: NodeJS.Platform): FleetTransport[] {
  const transports: FleetTransport[] = []
  if (env.TMUX && /^%\d{1,20}$/u.test(env.TMUX_PANE ?? "")) transports.push("tmux")
  if (env.ZELLIJ && /^\d{1,20}$/u.test(env.ZELLIJ_PANE_ID ?? "")) transports.push("zellij")
  if (platform === "darwin" && env.TERM_PROGRAM === "ghostty") transports.push("ghostty")
  return transports
}

/** Fleet job lifecycle currently uses host child sessions; terminal process launch is disabled until the CLI contract is verified. */
export function registerFleet(ctx: PluginContext, jobs: SessionJobRegistry): Promise<void> {
  return ctx.command.transform((editor) => editor.add({
    name: "fleet",
    description: "Start, inspect, wait for, or cancel session-owned Fleet jobs.",
    execute: async ({ sessionID, prompt }) => {
      const input = prompt.text.trim().replace(/^\/fleet\s*/i, "")
      if (!input || input === "list") {
        const transports = availableFleetTransports(process.env, process.platform)
        const rows = await jobs.list(sessionID)
        const text = [
          `Terminal transports available by environment: ${transports.join(", ") || "none"}.`,
          "Terminal process launch is disabled until a supported OpenCode CLI session-attachment contract is verified.",
          rows.length ? JSON.stringify(rows.map(({ id, title, status, childSessionID }) => ({ id, title, status, childSessionID })), null, 2) : "No Fleet jobs.",
        ].join("\n\n")
        await ctx.session.synthetic({ sessionID, text, resume: false })
        return
      }
      const cancel = /^cancel\s+(\S+)$/i.exec(input)
      if (cancel) {
        await ctx.session.synthetic({ sessionID, text: await jobs.cancel(sessionID, cancel[1]!) ? "Fleet child session interrupted." : "No active Fleet job with that ID.", resume: false })
        return
      }
      const job = await jobs.spawn(sessionID, input, `fleet: ${input.slice(0, 80)}`)
      await ctx.session.synthetic({ sessionID, text: `Fleet job ${job.id} started in isolated OpenCode session ${job.childSessionID}. Use subagent_wait to collect the result. Terminal process launch remains guarded pending a verified CLI session-attachment contract.`, resume: false })
    },
  })).then(() => undefined)
}
