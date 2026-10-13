import type { PluginContext } from "../plugin-types.ts"

const KEY = (sessionID: string) => `provider-context/context-rollover/${sessionID}`
const MAX_SESSION_ID = 256

export type RolloverState = { version: 1; enabled: boolean }

export function parseRolloverState(value: unknown): RolloverState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { version: 1, enabled: false }
  const state = value as Record<string, unknown>
  return state.version === 1 && typeof state.enabled === "boolean" ? { version: 1, enabled: state.enabled } : { version: 1, enabled: false }
}

export async function registerContextManagement(ctx: PluginContext): Promise<void> {
  await ctx.command.transform((editor) => editor.add({
    name: "context-management",
    description: "Opt in to explicit native context rollover for this session",
    execute: async ({ sessionID, prompt }) => {
      if (sessionID.length > MAX_SESSION_ID) throw new Error("Session ID exceeds the supported limit")
      const action = prompt.text.trim().toLowerCase() || "status"
      const current = parseRolloverState(await ctx.storage.get(KEY(sessionID)))
      if (action === "enable") {
        await ctx.storage.set(KEY(sessionID), { version: 1, enabled: true })
        await ctx.session.synthetic({ sessionID, resume: false, text: "Context rollover is opted in for this session. Run /context-management rollover to request OpenCode's native compaction; the plugin does not rewrite or prune transcript history." })
        return
      }
      if (action === "disable") {
        await ctx.storage.set(KEY(sessionID), { version: 1, enabled: false })
        await ctx.session.synthetic({ sessionID, resume: false, text: "Context rollover is disabled for this session." })
        return
      }
      if (action === "rollover") {
        if (!current.enabled) {
          await ctx.session.synthetic({ sessionID, resume: false, text: "Context rollover is disabled. Run /context-management enable first." })
          return
        }
        await ctx.session.compact({ sessionID })
        return
      }
      if (action !== "status" && action !== "help") throw new Error("Use /context-management status|enable|disable|rollover")
      await ctx.session.synthetic({ sessionID, resume: false, text: `Context rollover: ${current.enabled ? "enabled" : "disabled"} for this session. It uses OpenCode's native summary compaction only when you explicitly run /context-management rollover. State is keyed by session ID; forks start disabled unless separately enabled.` })
    },
  }))
}
