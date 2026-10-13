import { randomUUID } from "node:crypto"

export type GoalStatus = "active" | "paused" | "waiting" | "blocked" | "usage_limited" | "budget_limited" | "complete"
export interface GoalState {
  id: string
  objective: string
  status: GoalStatus
  createdAt: number
  updatedAt: number
  automaticTurns: number
  automaticTurnLimit: number
  tokensUsed: number
  tokenBudget?: number
  waitingFor?: string
  resumeAt?: number
  summary?: string
  evidence?: string[]
  lastError?: string
  usageEventIDs?: string[]
}

export type GoalCommand =
  | { kind: "status" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "start" | "edit"; objective: string; tokenBudget?: number }

export function parseGoalCommand(raw: string): GoalCommand | { kind: "error"; message: string } {
  const input = raw.trim().replace(/^\/goal(?:\s+)?/i, "")
  if (!input) return { kind: "status" }
  const [head, ...tail] = input.split(/\s+/)
  const rest = tail.join(" ")
  if (head === "status") return rest ? { kind: "error", message: "Usage: /goal status" } : { kind: "status" }
  if (head === "pause") return rest ? { kind: "error", message: "Usage: /goal pause" } : { kind: "pause" }
  if (head === "resume") return rest ? { kind: "error", message: "Usage: /goal resume" } : { kind: "resume" }
  if (head === "clear" || head === "stop") return rest ? { kind: "error", message: "Usage: /goal clear" } : { kind: "clear" }
  let edit = false
  let objectiveInput = input
  if (head === "edit") {
    edit = true
    objectiveInput = rest
  }
  if (head === "add" || head === "prioritize" || head === "drop-last" || head === "push" || head === "unshift" || head === "pop" || head === "shift") {
    return { kind: "error", message: `/${head} was removed from pi-goal. Run /goal status to inspect the active goal.` }
  }
  if (edit && !objectiveInput) return { kind: "error", message: "Usage: /goal edit <objective>" }
  const match = /^--tokens\s+(\S+)\s+(.+)$/.exec(objectiveInput)
  let tokenBudget: number | undefined
  if (match) {
    tokenBudget = parseTokenBudget(match[1]!)
    if (!tokenBudget) return { kind: "error", message: `Invalid token budget: ${match[1]}` }
    objectiveInput = match[2]!
  }
  const objective = objectiveInput.trim()
  if (!objective || objective.length > 4000) return { kind: "error", message: "A goal objective must contain 1–4,000 characters." }
  return { kind: edit ? "edit" : "start", objective, tokenBudget }
}

export function parseTokenBudget(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(value.trim())
  if (!match) return undefined
  const amount = Number(match[1])
  const result = Math.floor(amount * (match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1))
  return Number.isSafeInteger(result) && result > 0 ? result : undefined
}

export function startGoal(objective: string, options: { id?: string; now?: number; tokenBudget?: number; automaticTurnLimit?: number } = {}): GoalState {
  const now = options.now ?? Date.now()
  return {
    id: options.id ?? randomUUID(), objective: objective.trim(), status: "active",
    createdAt: now, updatedAt: now, automaticTurns: 0,
    automaticTurnLimit: options.automaticTurnLimit ?? 25,
    tokensUsed: 0, ...(options.tokenBudget ? { tokenBudget: options.tokenBudget } : {}),
  }
}

export function transitionGoal(goal: GoalState, status: GoalStatus, details: Partial<Pick<GoalState, "waitingFor" | "resumeAt" | "summary" | "evidence" | "lastError">> = {}, now = Date.now()): GoalState {
  return { ...goal, ...details, status, updatedAt: now }
}

export function recordGoalUsage(goal: GoalState, tokens: number, now = Date.now()): GoalState {
  const tokensUsed = goal.tokensUsed + Math.max(0, Math.floor(tokens))
  const automaticTurns = goal.automaticTurns + 1
  const status: GoalStatus = goal.tokenBudget !== undefined && tokensUsed >= goal.tokenBudget
    ? "budget_limited"
    : automaticTurns >= goal.automaticTurnLimit
      ? "paused"
      : goal.status
  return { ...goal, tokensUsed, automaticTurns, status, updatedAt: now }
}

export function canResumeGoal(goal: GoalState): boolean {
  if (!["paused", "blocked", "usage_limited", "budget_limited", "waiting"].includes(goal.status)) return false
  return goal.tokenBudget === undefined || goal.tokensUsed < goal.tokenBudget
}

export function validGoalState(value: unknown): value is GoalState {
  if (!value || typeof value !== "object") return false
  const row = value as Partial<GoalState>
  return typeof row.id === "string" && row.id.length > 0 && typeof row.objective === "string" &&
    ["active", "paused", "waiting", "blocked", "usage_limited", "budget_limited", "complete"].includes(String(row.status)) &&
    Number.isSafeInteger(row.createdAt) && Number.isSafeInteger(row.updatedAt) &&
    Number.isSafeInteger(row.automaticTurns) && Number.isSafeInteger(row.automaticTurnLimit) &&
    Number.isSafeInteger(row.tokensUsed) && (row.tokenBudget === undefined || Number.isSafeInteger(row.tokenBudget)) &&
    (row.usageEventIDs === undefined || (Array.isArray(row.usageEventIDs) && row.usageEventIDs.every((id) => typeof id === "string")))
}

export function renderGoalStatus(goal: GoalState): string {
  const budget = goal.tokenBudget === undefined ? "no token budget" : `${goal.tokensUsed}/${goal.tokenBudget} tokens`
  return `Goal ${goal.status} (${goal.automaticTurns}/${goal.automaticTurnLimit} automatic turns; ${budget})\n${goal.objective}${goal.waitingFor ? `\nWaiting for: ${goal.waitingFor}` : ""}${goal.summary ? `\nSummary: ${goal.summary}` : ""}`
}
