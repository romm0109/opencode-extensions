import { registerFileContext } from "./file-context.ts";
import type { PluginContext } from "./plugin-types.ts";
import { registerToolCatalog } from "./tool-catalog.ts";
import { registerWorktreeCommands } from "./worktree.ts";

/** Register file-context quoting, tool catalog inspection, and native worktree commands. */
export async function registerAdditionalExtensions(context: PluginContext): Promise<void> {
  await Promise.all([registerFileContext(context), registerToolCatalog(context), registerWorktreeCommands(context)]);
}
