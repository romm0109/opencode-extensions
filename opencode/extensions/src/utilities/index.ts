import type { Context as TuiContext } from "@opencode/plugin/tui/context"
import type { PluginContext } from "../plugin-types.ts"
import { registerCaffeinate } from "./caffeinate.ts"
import { registerDotenv } from "./dotenv.ts"
import { registerGitHubPr } from "./github-pr.ts"
import { registerLsp } from "./lsp.ts"
import { registerTicker } from "./ticker.ts"
import { registerUtilityTui } from "./tui.ts"

/** Register utility server-side commands/tools; caller owns the returned lifecycle cleanup. */
export async function registerUtilityExtensions(context: PluginContext): Promise<() => Promise<void>> {
  const stopCaffeinate = await registerCaffeinate(context)
  try {
    await Promise.all([
      registerGitHubPr(context),
      registerTicker(context),
      registerDotenv(context),
      registerLsp(context),
    ])
  } catch (error) {
    await stopCaffeinate()
    throw error
  }
  return async () => { await stopCaffeinate() }
}

/** Register native CLI/TUI surfaces in the separate OpenCode CLI plugin. */
export { registerUtilityTui }
export type { TuiContext }
