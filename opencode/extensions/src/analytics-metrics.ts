/** Content-free analytics derived only from public OpenCode 2.0.28 events. */
export type OpenCodeMetricEvent = {
  id?: string
  created?: number
  type: string
  data?: Record<string, unknown>
}

export type AnalyticsSnapshot = {
  responseCycles: number
  generations: number
  toolCalls: number
  toolErrors: number
  skillActivations: number
  reportedCostUsd: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outcomes: Record<string, number>
  tools: Record<string, { calls: number; failures: number }>
  skills: Record<string, number>
}

/**
 * Project events into an aggregate that deliberately contains no prompts,
 * generated text, tool input/output, file paths, or provider error messages.
 * Event IDs are deduplicated because durable events can be replayed.
 */
export function summarizeAnalytics(events: readonly OpenCodeMetricEvent[]): AnalyticsSnapshot {
  const seen = new Set<string>()
  const toolNames = new Map<string, string>()
  const result: AnalyticsSnapshot = {
    responseCycles: 0, generations: 0, toolCalls: 0, toolErrors: 0,
    skillActivations: 0, reportedCostUsd: 0, inputTokens: 0, outputTokens: 0,
    reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    outcomes: {}, tools: {}, skills: {},
  }
  const add = (record: Record<string, number>, key: unknown) => {
    if (typeof key === "string" && key) record[key] = (record[key] ?? 0) + 1
  }
  for (const event of events) {
    if (event.id && seen.has(event.id)) continue
    if (event.id) seen.add(event.id)
    const data = event.data ?? {}
    switch (event.type) {
      case "session.execution.started": result.responseCycles++; break
      case "session.execution.succeeded": add(result.outcomes, "execution:success"); break
      case "session.execution.failed": add(result.outcomes, "execution:error"); break
      case "session.execution.interrupted": add(result.outcomes, "execution:interrupted"); break
      case "session.step.ended": {
        result.generations++
        const tokens = object(data.tokens)
        const cache = object(tokens.cache)
        result.inputTokens += number(tokens.input)
        result.outputTokens += number(tokens.output)
        result.reasoningTokens += number(tokens.reasoning)
        result.cacheReadTokens += number(cache.read)
        result.cacheWriteTokens += number(cache.write)
        result.reportedCostUsd += number(data.cost)
        add(result.outcomes, `generation:${typeof data.finish === "string" ? data.finish : "unknown"}`)
        break
      }
      case "session.tool.input.started":
        if (typeof data.id === "string" && typeof data.name === "string") toolNames.set(data.id, safeName(data.name) ?? "")
        break
      case "session.tool.called": {
        if (data.executed !== true) break
        result.toolCalls++
        // Tool names are metadata. Never retain input or output payloads.
        addTool(result, { name: toolNames.get(String(data.id)) ?? data.name })
        break
      }
      case "session.tool.failed": {
        if (data.executed !== true) break
        result.toolErrors++
        failTool(result, { name: toolNames.get(String(data.id)) ?? data.name })
        break
      }
      case "session.skill.activated":
        result.skillActivations++
        add(result.skills, data.name)
        break
    }
  }
  return result
}

function addTool(result: AnalyticsSnapshot, data: Record<string, unknown>) {
  const name = safeName(data.name ?? data.tool)
  if (name) result.tools[name] = { calls: (result.tools[name]?.calls ?? 0) + 1, failures: result.tools[name]?.failures ?? 0 }
}
function failTool(result: AnalyticsSnapshot, data: Record<string, unknown>) {
  const name = safeName(data.name ?? data.tool)
  if (!name) return
  const tool = result.tools[name] ?? { calls: 0, failures: 0 }
  tool.failures++
  result.tools[name] = tool
}
function safeName(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 80) : undefined
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0 }
