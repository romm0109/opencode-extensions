import { summarizeAnalytics, type OpenCodeMetricEvent } from "./analytics-metrics.ts"
import type { PluginContext } from "./plugin-types.ts"

const STORE = "observability/analytics-events"
const LIMIT = 10_000

export async function registerAnalytics(ctx: PluginContext): Promise<() => void> {
  const controller = new AbortController()
  const consumer = (async () => {
    try {
      for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
        const event = raw as unknown as OpenCodeMetricEvent
        if (!event.type.startsWith("session.")) continue
        const existing = await ctx.storage.get(STORE)
        const events = Array.isArray(existing) ? existing.filter(isMetricEvent) : []
        events.push(project(event))
        await ctx.storage.set(STORE, JSON.parse(JSON.stringify(events.slice(-LIMIT))))
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error("OpenCode analytics event stream stopped", error)
    }
  })()
  await ctx.command.transform((editor) => editor.add({
    name: "analytics",
    description: "Show content-free session usage metrics recorded by the plugin",
    execute: async ({ sessionID }) => {
      const raw = await ctx.storage.get(STORE)
      const snapshot = summarizeAnalytics(Array.isArray(raw) ? raw.filter(isMetricEvent) : [])
      await ctx.session.synthetic({ sessionID, text: JSON.stringify(snapshot, null, 2), resume: false })
    },
  }))
  return () => { controller.abort(); void consumer }
}

function project(event: OpenCodeMetricEvent): OpenCodeMetricEvent {
  const source = event.data ?? {}
  const data: Record<string, unknown> = {}
  for (const key of ["sessionID", "id", "name", "executed", "finish", "cost", "tokens", "created", "reason"]) {
    const value = source[key]
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") data[key] = value
    else if (value && typeof value === "object" && key === "tokens") data[key] = projectTokens(value)
  }
  return { id: event.id, created: event.created, type: event.type, data }
}

function projectTokens(value: object): Record<string, number | Record<string, number>> {
  const tokens = value as Record<string, unknown>
  const result: Record<string, number | Record<string, number>> = {}
  for (const key of ["input", "output", "reasoning"]) if (typeof tokens[key] === "number") result[key] = tokens[key] as number
  const cache = tokens.cache
  if (cache && typeof cache === "object") {
    const counts: Record<string, number> = {}
    for (const key of ["read", "write"]) if (typeof (cache as Record<string, unknown>)[key] === "number") counts[key] = (cache as Record<string, number>)[key]!
    result.cache = counts
  }
  return result
}

function isMetricEvent(value: unknown): value is OpenCodeMetricEvent {
  return !!value && typeof value === "object" && typeof (value as OpenCodeMetricEvent).type === "string"
}
