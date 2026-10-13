/** Native presentation helpers for OpenCode's public terminal slots. */
export type FooterMode = "statusline" | "starship" | "off"
export type StatusPreset = "minimal" | "balanced" | "verbose"

export const STARSHIP_MODULES = [
  "activity", "aws", "azure", "brand", "bun", "cache", "conda", "container", "context", "cost",
  "deno", "directory", "direnv", "docker_context", "extension_status", "fill", "gcloud", "git_branch",
  "git_commit", "git_metrics", "git_state", "git_status", "git_worktree", "github_pr", "golang", "guix_shell",
  "hostname", "kubernetes", "mise", "model", "nix_shell", "nodejs", "openstack", "os", "package", "pixi",
  "provider", "python", "rust", "terraform", "thinking", "time", "tokens", "turn", "username",
] as const

export const STATUS_PRESETS: Record<StatusPreset, readonly string[]> = {
  minimal: ["model", "cwd", "branch"],
  balanced: ["brand", "session", "provider", "model", "thinking", "cwd", "branch", "context", "tokens", "cost", "time"],
  verbose: ["brand", "session", "provider", "model", "thinking", "cwd", "branch", "tools", "context", "tokens", "cache", "cost", "time", "turn"],
}

export type StatusData = {
  title?: string
  sessionID?: string
  model?: string
  provider?: string
  thinking?: string
  status?: string
  cost?: number
  input?: number
  output?: number
  root?: string
  branch?: string
  contextPercent?: number
  cachePercent?: number
  toolCount?: number
  completedAt?: number
}

export function statuslineSegments(data: StatusData, preset: StatusPreset): string[] {
  const values: Record<string, string> = {
    brand: "◆",
    session: data.title ?? "",
    provider: data.provider ?? "provider",
    model: data.model ?? "default model",
    thinking: data.thinking ?? "",
    cwd: data.root?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "workspace",
    branch: data.branch ? ` ${data.branch}` : "",
    tools: data.toolCount ? `${data.toolCount} tools` : "",
    context: data.contextPercent === undefined ? "" : `${data.contextPercent.toFixed(0)}% ctx`,
    tokens: `↑${compact(data.input)} ↓${compact(data.output)}`,
    cache: data.cachePercent === undefined ? "" : `${data.cachePercent.toFixed(0)}% cache`,
    cost: Number.isFinite(data.cost) ? `$${data.cost!.toFixed(3)}` : "",
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    turn: "",
  }
  return STATUS_PRESETS[preset].map((name) => values[name]).filter((value) => Boolean(value))
}

export function renderStatusline(data: StatusData, preset: StatusPreset, width: number): string {
  const prefix = data.status === "running" ? "●" : "○"
  const full = [prefix, ...statuslineSegments(data, preset)].join(" · ")
  return fitCells(full, Math.max(1, width))
}

export type StarshipTemplate = { format: string; modules: Partial<Record<string, Record<string, unknown>>>; palette?: string; palettes: Record<string, Record<string, string>> }

export const BUILT_IN_STARSHIP_TEMPLATE = "$brand$model$thinking$directory$git_branch$git_status$activity$context$time"
export const STARSHIP_PALETTES: Record<string, Record<string, string>> = {
  "tokyo-night": { blue: "#7aa2f7", cyan: "#7dcfff", green: "#9ece6a", magenta: "#bb9af7", red: "#f7768e", yellow: "#e0af68" },
  ocean: { blue: "#89b4fa", cyan: "#94e2d5", green: "#a6e3a1", magenta: "#cba6f7", red: "#f38ba8", yellow: "#f9e2af" },
  sunset: { blue: "#89b4fa", cyan: "#94e2d5", green: "#a6e3a1", magenta: "#f5c2e7", red: "#f38ba8", yellow: "#fab387" },
  forest: { blue: "#83c5be", cyan: "#a8dadc", green: "#95d5b2", magenta: "#b7b7a4", red: "#e5989b", yellow: "#e9c46a" },
  candy: { blue: "#89b4fa", cyan: "#94e2d5", green: "#a6e3a1", magenta: "#f5c2e7", red: "#f38ba8", yellow: "#f9e2af" },
  neon: { blue: "#00e5ff", cyan: "#00ffc8", green: "#aaff00", magenta: "#ff00ff", red: "#ff1744", yellow: "#ffff00" },
  mono: { blue: "#b0b0b0", cyan: "#c0c0c0", green: "#d0d0d0", magenta: "#a0a0a0", red: "#909090", yellow: "#e0e0e0" },
}

/** Parse Starship TOML templates while preserving module options and palette tables. */
export function parseStarshipToml(source: string): StarshipTemplate {
  const parsed = parseTomlDocument(source)
  const result: StarshipTemplate = { format: BUILT_IN_STARSHIP_TEMPLATE, modules: {}, palettes: {} }
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "format") { if (typeof value !== "string") throw new Error("format must be a string"); result.format = value }
    else if (key === "palette") { if (typeof value !== "string") throw new Error("palette must be a string"); result.palette = value }
    else if (key === "palettes") {
      if (!isObject(value)) throw new Error("palettes must be a TOML table")
      for (const [name, colors] of Object.entries(value)) {
        if (!isObject(colors)) throw new Error(`Palette ${name} must be a table`)
        const entries: Record<string, string> = {}
        for (const [color, token] of Object.entries(colors)) if (typeof token === "string") entries[color] = token
        result.palettes[name] = entries
      }
    } else {
      if (!STARSHIP_MODULES.includes(key as never)) throw new Error(`Unknown module ${key}`)
      if (!isObject(value)) throw new Error(`Module ${key} must be a TOML table`)
      result.modules[key] = value
    }
  }
  return result
}

/** Expand Starship's $module format variables, then fit by terminal cells. */
export function renderStarship(template: StarshipTemplate, data: StatusData, width: number): string {
  const palette = { ...STARSHIP_PALETTES[template.palette ?? "tokyo-night"], ...template.palettes[template.palette ?? ""] }
  const values: Record<string, string> = {
    brand: "◆", model: data.model ?? "default model", provider: data.provider ?? "provider", thinking: "",
    directory: data.root?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "workspace",
    git_branch: data.branch ? ` ${data.branch}` : "", git_status: "", activity: data.status === "running" ? "● running" : "",
    context: data.contextPercent === undefined ? "" : `${data.contextPercent.toFixed(0)}%`, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    cost: Number.isFinite(data.cost) ? `$${data.cost!.toFixed(3)}` : "", tokens: `↑${compact(data.input)} ↓${compact(data.output)}`,
    git_commit: "", git_metrics: "", git_state: "", git_worktree: "", github_pr: "", cache: "", extension_status: "",
  }
  const fillToken = "\u0000FILL\u0000"
  let output = stripTerminalControls(template.format).replace(/\\\n\s*/gu, "")
  output = output.replace(/\$fill\b/gu, fillToken)
  output = output.replace(/\[([^\]]*)\]\(([^)]*)\)/gu, (_all, content: string, style: string) => {
    const expanded = expandVariables(content, values, template)
    return expanded ? applyAnsi(expanded, style, palette) : ""
  })
  output = expandVariables(output, values, template)
  output = output.replace(/\(([^()]*)\)/gu, (_all, conditional: string) => {
    const expanded = expandVariables(conditional, values, template)
    return expanded ? expanded : ""
  })
  output = output.replaceAll(fillToken, " ".repeat(Math.max(0, width - visibleCells(output.replaceAll(fillToken, "")))))
  return fitCells(output.replace(/\\/gu, ""), Math.max(1, width))
}

function expandVariables(input: string, values: Record<string, string>, template: StarshipTemplate): string {
  return input.replace(/\$([a-z_]+)/gu, (_all, key: string) => {
    const config = template.modules[key]
    if (config?.disabled === true) return ""
    const value = values[key] ?? ""
    if (!value) return ""
    const symbol = typeof config?.symbol === "string" ? config.symbol : ""
    const format = typeof config?.format === "string" ? config.format : ""
    if (format) {
      let moduleValue = format.replace(/\$([a-z_]+)/gu, (match, name: string) => {
        if (name === "symbol") return symbol
        if (name === "style") return typeof config?.style === "string" ? config.style : ""
        if (name === key) return value
        if (name === "path" && key === "directory") return value
        if (name === "branch" && key === "git_branch") return value.replace(/^\s*/u, "")
        if (name === "text" && key === "activity") return value
        return match
      })
      const palette = template.palette ? (template.palettes[template.palette] ?? STARSHIP_PALETTES[template.palette] ?? {}) : STARSHIP_PALETTES["tokyo-night"]!
      moduleValue = moduleValue.replace(/\[([^\]]*)\]\(([^)]*)\)/gu, (_group, content: string, style: string) => applyAnsi(content, style, palette))
      moduleValue = moduleValue.replace(/\(([^()]*)\)/gu, (_group, conditional: string) => conditional || "")
      const style = typeof config?.style === "string" ? config.style : ""
      return style ? applyAnsi(moduleValue, style, palette) : moduleValue
    }
    return `${symbol}${value}`
  })
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }

function parseTomlDocument(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let current = root
  const lines = source.replace(/^\ufeff/u, "").split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index]!.trim()
    if (!line || line.startsWith("#")) continue
    const section = line.match(/^\[([\w.-]+)\]$/u)
    if (section) {
      current = root
      for (const part of section[1]!.split(".")) {
        const existing = current[part]
        if (existing !== undefined && !isObject(existing)) throw new Error(`TOML table conflicts with value: ${part}`)
        current[part] = existing ?? {}
        current = current[part] as Record<string, unknown>
      }
      continue
    }
    const arraySection = line.match(/^\[\[([\w.-]+)\]\]$/u)
    if (arraySection) {
      const parts = arraySection[1]!.split(".")
      const key = parts.pop()!
      current = root
      for (const part of parts) {
        current[part] ??= {}
        if (!isObject(current[part])) throw new Error(`TOML table conflicts with value: ${part}`)
        current = current[part] as Record<string, unknown>
      }
      const rows = current[key] ?? []
      if (!Array.isArray(rows)) throw new Error(`TOML array table conflicts with value: ${key}`)
      const row: Record<string, unknown> = {}
      rows.push(row)
      current[key] = rows
      current = row
      continue
    }
    const assignment = line.match(/^([\w-]+)\s*=\s*(.*)$/u)
    if (!assignment) throw new Error(`Unsupported TOML syntax at line ${index + 1}`)
    const key = assignment[1]!
    let raw = assignment[2]!.trim()
    if (raw.startsWith('"""') || raw.startsWith("'''")) {
      const delimiter = raw.slice(0, 3)
      raw = raw.slice(3)
      const parts = [raw]
      while (!raw.includes(delimiter.slice(0, 3)) && index + 1 < lines.length) {
        raw = lines[++index]!
        parts.push(raw)
      }
      const joined = parts.join("\n")
      const end = joined.lastIndexOf(delimiter)
      if (end < 0) throw new Error(`Unterminated multiline TOML string for ${key}`)
      const value = joined.slice(0, end).replace(/^\n/u, "")
      setTomlValue(current, key, delimiter === '"""' ? unescapeToml(value) : value)
      continue
    }
    raw = stripTomlComment(raw)
    setTomlValue(current, key, parseTomlValue(raw))
  }
  return root
}

function setTomlValue(target: Record<string, unknown>, key: string, value: unknown): void {
  if (Object.hasOwn(target, key)) throw new Error(`Duplicate TOML key ${key}`)
  target[key] = value
}

function stripTomlComment(value: string): string {
  let quoted = false
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!
    if (escaped) { escaped = false; continue }
    if (quoted && char === "\\") { escaped = true; continue }
    if (char === '"') quoted = !quoted
    else if (char === "#" && !quoted) return value.slice(0, index).trim()
  }
  return value.trim()
}

function parseTomlValue(raw: string): unknown {
  if (raw === "true") return true
  if (raw === "false") return false
  if (/^[+-]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][+-]?\d+)?$/u.test(raw)) return Number(raw)
  if (raw.startsWith('"') && raw.endsWith('"')) return unescapeToml(raw.slice(1, -1))
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1)
  if (raw.startsWith("[") && raw.endsWith("]")) return splitTomlArray(raw.slice(1, -1)).map(parseTomlValue)
  if (raw.startsWith("{") && raw.endsWith("}")) {
    const result: Record<string, unknown> = {}
    for (const field of splitTomlArray(raw.slice(1, -1))) {
      const match = field.match(/^([\w-]+)\s*=\s*(.+)$/u)
      if (!match) throw new Error(`Invalid inline TOML table: ${field}`)
      setTomlValue(result, match[1]!, parseTomlValue(match[2]!))
    }
    return result
  }
  throw new Error(`Unsupported TOML value: ${raw}`)
}

function splitTomlArray(source: string): string[] {
  const result: string[] = []
  let start = 0
  let depth = 0
  let quote = ""
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    if (escaped) { escaped = false; continue }
    if (quote === '"' && char === "\\") { escaped = true; continue }
    if (quote) { if (char === quote) quote = ""; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === "[" || char === "{") depth += 1
    else if (char === "]" || char === "}") depth -= 1
    else if (char === "," && depth === 0) { result.push(source.slice(start, index).trim()); start = index + 1 }
  }
  const tail = source.slice(start).trim()
  if (tail) result.push(tail)
  return result
}

function unescapeToml(value: string): string {
  return value.replace(/\\([btnfre"\\])/gu, (_match, char: string) => ({ b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\u001b", '"': '"', "\\": "\\" })[char] ?? char)
}

function applyAnsi(value: string, style: string, palette: Record<string, string>): string {
  const color = style.split(/\s+/u).map((part) => part.replace(/^(fg|bg):/u, "")).map((part) => palette[part] ?? part).find((part) => /^#[\da-f]{6}$/iu.test(part))
  if (!color) return value
  const hex = color.slice(1)
  return `\u001b[38;2;${parseInt(hex.slice(0, 2), 16)};${parseInt(hex.slice(2, 4), 16)};${parseInt(hex.slice(4, 6), 16)}m${value}\u001b[0m`
}

function compact(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value) : "0"
}

export function visibleCells(value: string): number {
  const clean = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  let width = 0
  for (const { segment } of graphemes.segment(clean)) {
    if (/\p{Extended_Pictographic}/u.test(segment) || /\p{Regional_Indicator}/u.test(segment)) { width += 2; continue }
    for (const char of segment) {
      if (/\p{Mark}/u.test(char) || char === "\u200d" || /[\ufe00-\ufe0f]/u.test(char)) continue
      width += /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}]/u.test(char) ? 2 : 1
    }
  }
  return width
}

export function fitCells(value: string, width: number): string {
  return value.split("\n").map((line) => fitSingleLine(line, width)).join("\n")
}

function fitSingleLine(value: string, width: number): string {
  if (visibleCells(value) <= width) return value
  if (width <= 1) return "…".slice(0, width)
  const target = width - 1
  let used = 0
  let output = ""
  for (const char of value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")) {
    const cells = visibleCells(char)
    if (used + cells > target) break
    output += char
    used += cells
  }
  return `${output}…`
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
}

export type ShowcaseState = { page: "menu" | "actions" | "selection" | "input" | "confirm" | "search" | "busy"; selected: number; selectedProfile: number; input: string; query: string; message: string; busy: boolean }
export function createShowcaseState(): ShowcaseState { return { page: "menu", selected: 0, selectedProfile: 1, input: "", query: "", message: "Select with ↑/↓, Enter opens, Esc cancels." , busy: false } }
