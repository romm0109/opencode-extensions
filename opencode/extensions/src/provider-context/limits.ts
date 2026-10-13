import type { PluginContext } from "../plugin-types.ts";

export async function registerCompactionLimitations(ctx: PluginContext): Promise<void> {
  const reports = {
    "codex-compact":
      "Custom Codex checkpoint replay is disabled. OpenCode 2.0.28 exposes providerState as opaque JSON but does not expose the active account identity or resolved endpoint to this plugin. The replay gate requires exact provider, model, account fingerprint, endpoint origin, and protocol matches; native compaction remains in control.",
    "typesafe-compact":
      "Selective TypeSafe compaction is not activated. The native compaction hook has no AbortSignal, and the plugin cannot safely cancel a billed evaluator request when the user interrupts. The tested selection core is available to a later adapter; OpenCode native compaction remains the fallback.",
  };
  await ctx.command.transform((editor) => {
    for (const [name, text] of Object.entries(reports))
      editor.add({
        name,
        description: "Show the native compaction adapter status and API boundary",
        execute: async ({ sessionID }) => {
          await ctx.session.synthetic({ sessionID, resume: false, text });
        },
      });
  });
}
