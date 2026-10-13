import { registerFileContext } from "./file-context.ts";
import type { PluginContext } from "./plugin-types.ts";
import { registerProviderContextExtensions } from "./provider-context/index.ts";
import { registerToolCatalog } from "./tool-catalog.ts";
import { registerWorktreeCommands } from "./worktree.ts";

/** Register local workspace tools plus the explicit provider/context adapters. */
export async function registerAdditionalExtensions(context: PluginContext): Promise<() => Promise<void>> {
  await Promise.all([registerFileContext(context), registerToolCatalog(context), registerWorktreeCommands(context)]);
  return registerProviderContextExtensions(context);
}
