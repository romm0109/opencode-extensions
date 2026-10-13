import type { PluginContext } from "./plugin-types.ts"

export async function registerToolCatalog(context: PluginContext): Promise<void> {
  await context.command.transform((editor) => {
    editor.add({
      name: "tool",
      description: "Inspect the tools registered with OpenCode",
      execute: async ({ sessionID, prompt }) => {
        const argument = prompt.text.replace(/^\/tool\s*/i, "").trim()
        const tools = await context.tool.list()
        const selected = argument ? tools.find((tool) => tool.id === argument || tool.name === argument) : undefined
        let text: string
        if (argument && !selected) {
          text = `No registered tool named ${JSON.stringify(argument)}. Use /tool to list available tools.`
        } else if (selected) {
          text = [
            `${selected.name}: ${selected.description}`,
            `Registered ID: ${selected.id}`,
            `Options: ${JSON.stringify(selected.options ?? {})}`,
            `Input schema: ${JSON.stringify(selected.input, null, 2)}`,
          ].join("\n\n")
        } else {
          text = tools.length
            ? `Registered tools (${tools.length}):\n${[...tools].sort((a, b) => a.name.localeCompare(b.name)).map((tool) => `- ${tool.name}: ${tool.description}`).join("\n")}\n\nUse /tool <name> to inspect its schema.`
            : "No tools are currently registered."
        }
        await context.session.synthetic({ sessionID, text, resume: false })
      },
    })
  })
}
