/** Cache diagnostics based on OpenCode's explicit session.step.ended counters. */
export type CacheUsage = { input: number; read: number; write: number; costUsd: number }
export type CacheMetrics = {
  requestCount: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  promptTokens: number
  hitRatePercent: number | null
  reportedCostUsd: number
  samples: Array<{ hitRatePercent: number | null; input: number; read: number; write: number; costUsd: number }>
}

/** Extract only public cache usage/cost fields from step-ended events. */
export function collectCacheUsage(events: readonly { id?: string; type: string; data?: Record<string, unknown> }[]): CacheUsage[] {
  const seen = new Set<string>()
  const records: CacheUsage[] = []
  for (const event of events) {
    if (event.type !== "session.step.ended") continue
    if (event.id && seen.has(event.id)) continue
    if (event.id) seen.add(event.id)
    const data = event.data ?? {}
    const tokens = obj(data.tokens)
    const cache = obj(tokens.cache)
    records.push({ input: finite(tokens.input), read: finite(cache.read), write: finite(cache.write), costUsd: finite(data.cost) })
  }
  return records
}

export function summarizeCache(records: readonly CacheUsage[]): CacheMetrics {
  const inputTokens = records.reduce((n, x) => n + x.input, 0)
  const cacheReadTokens = records.reduce((n, x) => n + x.read, 0)
  const cacheWriteTokens = records.reduce((n, x) => n + x.write, 0)
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens
  return {
    requestCount: records.length, inputTokens, cacheReadTokens, cacheWriteTokens, promptTokens,
    hitRatePercent: promptTokens > 0 ? cacheReadTokens / promptTokens * 100 : null,
    reportedCostUsd: records.reduce((n, x) => n + x.costUsd, 0),
    samples: records.map((x) => {
      const total = x.input + x.read + x.write
      return { ...x, hitRatePercent: total > 0 ? x.read / total * 100 : null }
    }),
  }
}

function obj(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {} }
function finite(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0 }
