import type { PluginContext } from "../plugin-types.ts"
import { registerProviderAccounts } from "./accounts.ts"
import { registerContextManagement } from "./context-management.ts"
import { registerTypesafeQuestion } from "./typesafe.ts"
import { registerTypesafeSearch } from "./search.ts"
import { registerProviderUsage } from "./usage.ts"
import { registerCompactionLimitations } from "./limits.ts"

/**
 * Optional provider/context module group. The main plugin entry does not import
 * this group; the integration owner can wire it after reviewing its commands.
 */
export async function registerProviderContextExtensions(ctx: PluginContext): Promise<() => Promise<void>> {
  await registerProviderAccounts(ctx)
  await registerCompactionLimitations(ctx)
  await registerContextManagement(ctx)
  await registerTypesafeQuestion(ctx)
  await registerTypesafeSearch(ctx)
  const cleanupUsage = await registerProviderUsage(ctx)
  return cleanupUsage
}

export { codexReplayDecision, parseCodexCheckpointProvenance } from "./codex-provenance.ts"
export { makeHistoryUnits, selectiveCompactionPlan } from "./typesafe-compact.ts"
export { normalizeJevInput, normalizeJevResponse } from "./jev-types.ts"
export { requestJevDecision } from "./jev-client.ts"
export { searchWorkspace, rerankSearchHits } from "./search.ts"
export { summarizeProviderUsage } from "./usage.ts"
