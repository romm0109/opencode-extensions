import { stripVTControlCharacters } from "node:util";
import type { PluginContext } from "../plugin-types.ts";

/** Read-only account/provider inventory; activation is deliberately not exposed. */
export async function registerProviderAccounts(ctx: PluginContext): Promise<void> {
  await ctx.command.transform((editor) =>
    editor.add({
      name: "provider-accounts",
      description: "List available providers and explain native account-switching limits",
      execute: async ({ sessionID }) => {
        const inventory = await ctx.provider.list();
        const providers = inventory.data
          .map((provider) => ({
            id: stripVTControlCharacters(provider.id).slice(0, 200),
            name: stripVTControlCharacters(provider.name).slice(0, 200),
            activation: provider.activation,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const rows = providers.length
          ? providers.map((provider) => `- ${provider.name} (${provider.id}; ${provider.activation})`)
          : ["- No providers are currently available."];
        await ctx.session.synthetic({
          sessionID,
          resume: false,
          text: [
            "Provider inventory (account identities are not exposed):",
            ...rows,
            "",
            "OpenCode 2.0.28 plugin context exposes credential activation by credential ID but no credential listing or session-scoped activation. This command is read-only; manage accounts with the host before starting a session. No account was switched.",
          ].join("\n"),
        });
      },
    }),
  );
}
