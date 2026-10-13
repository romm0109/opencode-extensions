import type { Plugin } from "@opencode/plugin"

export type PluginContext = Parameters<Plugin.Plugin["setup"]>[0]
