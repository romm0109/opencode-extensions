import { randomUUID } from "node:crypto"
import net from "node:net"
import type { PluginContext } from "../plugin-types.ts"

const MAX_FRAME_BYTES = 1_000_000
const REQUEST_TIMEOUT_MS = 1_500
export type HerdrAgentView = { paneID: string; workspaceID: string; agent?: string; status: string; title?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeField(value: string, maxBytes: number): string {
  let output = ""
  let bytes = 0
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
  for (const character of clean) {
    const length = Buffer.byteLength(character, "utf8")
    if (bytes + length > maxBytes) break
    output += character
    bytes += length
  }
  return output
}

export function parseHerdrAgentList(value: unknown): HerdrAgentView[] {
  if (!isRecord(value) || value.type !== "agent_list" || !Array.isArray(value.agents) || value.agents.length > 64) {
    throw new Error("Herdr returned an invalid agent list.")
  }
  return value.agents.map((row): HerdrAgentView => {
    if (!isRecord(row) || typeof row.pane_id !== "string" || !row.pane_id || typeof row.workspace_id !== "string" || !row.workspace_id) {
      throw new Error("Herdr returned an invalid agent record.")
    }
    const status = typeof row.agent_status === "string" && ["idle", "working", "blocked", "done", "unknown"].includes(row.agent_status)
      ? row.agent_status
      : "unknown"
    return {
      paneID: safeField(row.pane_id, 80),
      workspaceID: safeField(row.workspace_id, 80),
      ...(typeof row.agent === "string" ? { agent: safeField(row.agent, 80) } : {}),
      status,
      ...(typeof row.title === "string" ? { title: safeField(row.title, 120) } : {}),
    }
  })
}

/** Read-only local IPC call. No endpoint is contacted until the user invokes the command/tool. */
export function requestHerdrAgents(socketPath: string, signal?: AbortSignal): Promise<HerdrAgentView[]> {
  if (!socketPath.startsWith("/") || socketPath.includes("\0") || Buffer.byteLength(socketPath) > 103) {
    return Promise.reject(new Error("HERDR_SOCKET_PATH must be an absolute local Unix socket path."))
  }
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Cancelled."))
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    const requestID = randomUUID()
    let buffer = Buffer.alloc(0)
    let settled = false
    const finish = (error?: Error, value?: HerdrAgentView[]) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
      socket.destroy()
      if (error) reject(error)
      else resolve(value ?? [])
    }
    const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("Herdr query cancelled."))
    const timeout = setTimeout(() => finish(new Error("Herdr agent-list request timed out.")), REQUEST_TIMEOUT_MS)
    timeout.unref?.()
    signal?.addEventListener("abort", abort, { once: true })
    socket.on("error", () => finish(new Error("Could not connect to the configured local Herdr socket.")))
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: requestID, method: "agent.list", params: {} })}\n`))
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_FRAME_BYTES && buffer.indexOf(0x0a) < 0) return finish(new Error("Herdr response exceeded the size limit."))
      const end = buffer.indexOf(0x0a)
      if (end < 0) return
      if (end > MAX_FRAME_BYTES) return finish(new Error("Herdr response exceeded the size limit."))
      let frame: unknown
      try { frame = JSON.parse(buffer.subarray(0, end).toString("utf8")) } catch { return finish(new Error("Herdr returned invalid JSON.")) }
      if (!isRecord(frame)) return finish(new Error("Herdr returned an invalid response."))
      if (frame.id !== requestID) return finish(new Error("Herdr response did not match the active request."))
      if (isRecord(frame.error)) return finish(new Error("Herdr agent-list request failed."))
      try { finish(undefined, parseHerdrAgentList(frame.result)) } catch (error) { finish(error instanceof Error ? error : new Error("Herdr returned an invalid response.")) }
    })
    socket.on("end", () => { if (!settled) finish(new Error("Herdr closed the connection before returning an agent list.")) })
    socket.on("close", () => { if (!settled) finish(new Error("Herdr closed the connection before returning an agent list.")) })
  })
}

/** Register observation only. This module never reports status, creates panes, sends input, or changes accounts. */
export async function registerHerdr(ctx: PluginContext): Promise<void> {
  await ctx.tool.transform((editor) => editor.add({
    name: "herdr_agents",
    description: "Read agent status from an explicitly configured local Herdr Unix socket. Read-only; never creates, closes, or controls panes.",
    input: { type: "object" as const, properties: {}, required: [], additionalProperties: false as const },
    execute: async (_input, execution) => {
      if (process.env.HERDR_ENV !== "1") throw new Error("Herdr observation is disabled; set HERDR_ENV=1 in the OpenCode launcher to opt in.")
      const socketPath = process.env.HERDR_SOCKET_PATH
      if (!socketPath) throw new Error("HERDR_SOCKET_PATH is not configured.")
      return { content: JSON.stringify(await requestHerdrAgents(socketPath, execution.signal), null, 2) }
    },
  }))
  await ctx.command.transform((editor) => editor.add({
    name: "herdr",
    description: "Read the current Herdr agent list using an explicitly configured local socket.",
    execute: async ({ sessionID }) => {
      if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH) {
        await ctx.session.synthetic({ sessionID, text: "Herdr observation is disabled. Configure HERDR_ENV=1 and HERDR_SOCKET_PATH in the OpenCode launcher, then run /herdr. No connection is attempted automatically.", resume: false })
        return
      }
      const agents = await requestHerdrAgents(process.env.HERDR_SOCKET_PATH)
      await ctx.session.synthetic({ sessionID, text: agents.length ? JSON.stringify(agents, null, 2) : "Herdr reported no agents.", resume: false })
    },
  }))
}
