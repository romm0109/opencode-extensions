import type { PluginContext } from "../plugin-types.ts"

const STORE = "provider-context/usage-events"
const MAX_EVENTS = 10_000

export interface ProviderUsageEvent {
  id: string
  type: "session.step.ended"
  created: number
  data: { tokens: { input: number; output: number; reasoning: number; cache?: { read?: number; write?: number } }; cost: number }
}

export interface ProviderUsageSummary {
  steps: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reportedCost: number
}

export function summarizeProviderUsage(events: readonly ProviderUsageEvent[]): ProviderUsageSummary {
  return events.reduce<ProviderUsageSummary>((total, event) => {
    const tokens = event.data.tokens
    total.steps += 1
    total.inputTokens += tokens.input
    total.outputTokens += tokens.output
    total.reasoningTokens += tokens.reasoning
    total.cacheReadTokens += tokens.cache?.read ?? 0
    total.cacheWriteTokens += tokens.cache?.write ?? 0
    total.reportedCost += event.data.cost
    return total
  }, { steps: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reportedCost: 0 })
}

export function isProviderUsageEvent(value: unknown): value is ProviderUsageEvent {
  if (!value || typeof value !== "object") return false
  const event = value as Partial<ProviderUsageEvent>
  const data = event.data
  const tokens = data?.tokens
  return event.type === "session.step.ended" && typeof event.id === "string" && Number.isFinite(event.created) &&
    typeof data?.cost === "number" && Number.isFinite(data.cost) && data.cost >= 0 && data.cost <= 1e8 && !!tokens &&
    [tokens.input, tokens.output, tokens.reasoning].every((number) => Number.isSafeInteger(number) && number >= 0 && number <= 1e10) &&
    [tokens.cache?.read ?? 0, tokens.cache?.write ?? 0].every((number) => Number.isSafeInteger(number) && number >= 0 && number <= 1e10)
}

function projectUsageEvent(raw: { id: string; type: string; created: number; data: unknown }): ProviderUsageEvent | undefined {
  if (!raw.data || typeof raw.data !== "object") return undefined
  const data = raw.data as Record<string, unknown>
  const tokens = data.tokens
  if (!tokens || typeof tokens !== "object") return undefined
  const tokenData = tokens as Record<string, unknown>
  const cache = tokenData.cache && typeof tokenData.cache === "object" ? tokenData.cache as Record<string, unknown> : undefined
  const candidate: ProviderUsageEvent = {
    id: raw.id,
    type: "session.step.ended",
    created: raw.created,
    data: {
      cost: data.cost as number,
      tokens: {
        input: tokenData.input as number,
        output: tokenData.output as number,
        reasoning: tokenData.reasoning as number,
        ...(cache && (cache.read !== undefined || cache.write !== undefined) ? { cache: { ...(cache.read === undefined ? {} : { read: cache.read as number }), ...(cache.write === undefined ? {} : { write: cache.write as number }) } } : {}),
      },
    },
  }
  return isProviderUsageEvent(candidate) ? candidate : undefined
}

export async function registerProviderUsage(ctx: PluginContext): Promise<() => Promise<void>> {
  const abort = new AbortController()
  const consumer = (async () => {
    try {
      for await (const raw of ctx.event.subscribe({ signal: abort.signal })) {
        if (raw.type !== "session.step.ended") continue
        const candidate = projectUsageEvent(raw)
        if (!candidate) continue
        const existing = await ctx.storage.get(STORE)
        const events = Array.isArray(existing) ? existing.filter(isProviderUsageEvent) : []
        if (events.some((event) => event.id === candidate.id)) continue
        events.push(candidate)
        await ctx.storage.set(STORE, JSON.parse(JSON.stringify(events.slice(-MAX_EVENTS))))
      }
    } catch {
      if (!abort.signal.aborted) console.error("Provider usage event stream stopped")
    }
  })()
  await ctx.command.transform((editor) => editor.add({
    name: "provider-usage",
    description: "Show locally observed OpenCode token and cost totals",
    execute: async ({ sessionID }) => {
      const raw = await ctx.storage.get(STORE)
      const summary = summarizeProviderUsage(Array.isArray(raw) ? raw.filter(isProviderUsageEvent) : [])
      await ctx.session.synthetic({
        sessionID,
        resume: false,
        text: `Locally observed usage (all sessions):\n${JSON.stringify(summary, null, 2)}\n\nThese are host-reported token and cost totals. Provider quota, remaining allowance, billing balance, and reset times are not available through this adapter.`,
      })
    },
  }))
  return async () => { abort.abort(); await consumer }
}
