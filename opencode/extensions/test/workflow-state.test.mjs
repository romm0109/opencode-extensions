import assert from "node:assert/strict"
import test from "node:test"
import { canResumeGoal, parseGoalCommand, parseTokenBudget, recordGoalUsage, startGoal, transitionGoal, validGoalState } from "../src/workflow-state.ts"

test("goal command parsing preserves lifecycle verbs and removed queue errors", () => {
  assert.deepEqual(parseGoalCommand("/goal pause"), { kind: "pause" })
  assert.deepEqual(parseGoalCommand("/goal stop"), { kind: "clear" })
  assert.deepEqual(parseGoalCommand("/goal edit --tokens 20k retain existing goal"), { kind: "edit", objective: "retain existing goal", tokenBudget: 20_000 })
  assert.equal(parseGoalCommand("/goal prioritize old goal").kind, "error")
  assert.equal(parseGoalCommand("/goal clear trailing").kind, "error")
  assert.equal(parseTokenBudget("1.5m"), 1_500_000)
  assert.equal(parseTokenBudget("-4k"), undefined)
})

test("goal lifecycle tracks budgets and stops automatic work at configured limits", () => {
  let goal = startGoal("ship", { id: "goal-a", now: 100, automaticTurnLimit: 2, tokenBudget: 10 })
  assert.equal(validGoalState(goal), true)
  goal = recordGoalUsage(goal, 4, 110)
  assert.equal(goal.status, "active")
  goal = recordGoalUsage(goal, 6, 120)
  assert.equal(goal.status, "budget_limited")
  assert.equal(goal.tokensUsed, 10)
  assert.equal(canResumeGoal(goal), false)
  const edited = transitionGoal({ ...goal, tokenBudget: 100 }, "paused", { lastError: "review" }, 130)
  assert.equal(canResumeGoal(edited), true)
  assert.equal(edited.lastError, "review")
})
