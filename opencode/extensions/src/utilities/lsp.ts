import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { constants, existsSync } from "node:fs"
import { lstat, open, realpath, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path"
import { randomUUID } from "node:crypto"
import process from "node:process"
import type { PluginContext } from "../plugin-types.ts"

const MAX_FILE_BYTES = 1_000_000
const MAX_FILES = 40
const MAX_OUTPUT = 50_000
const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_SERVERS: LspServer[] = [
  { name: "typescript", command: "typescript-language-server", args: ["--stdio"], extensions: [".ts", ".tsx", ".mts", ".cts"], languageId: "typescript" },
  { name: "javascript", command: "typescript-language-server", args: ["--stdio"], extensions: [".js", ".jsx", ".mjs", ".cjs"], languageId: "javascript" },
  { name: "python", command: "pyright-langserver", args: ["--stdio"], extensions: [".py", ".pyi"], languageId: "python" },
  { name: "rust", command: "rust-analyzer", args: [], extensions: [".rs"], languageId: "rust" },
  { name: "go", command: "gopls", args: [], extensions: [".go"], languageId: "go" },
  { name: "clangd-c", command: "clangd", args: ["--background-index"], extensions: [".c", ".h"], languageId: "c" },
  { name: "clangd-cpp", command: "clangd", args: ["--background-index"], extensions: [".cc", ".cpp", ".hpp", ".cxx"], languageId: "cpp" },
]

export type LspServer = { name: string; command: string; args: string[]; extensions: string[]; languageId: string; env?: Record<string, string> }
export type Diagnostic = { range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } }; severity?: number; code?: string | number | { value?: string | number }; message?: string; source?: string }
export type LspResult = { path: string; server: string; diagnostics: Diagnostic[] }

/** Resolve Windows executable shims against the child PATH/cwd and invoke batch shims via ComSpec. */
export function resolveServerLaunch(server: LspServer, cwd: string, platform = process.platform, env: NodeJS.ProcessEnv = process.env) {
  if (platform !== "win32") return { command: server.command, args: [...server.args] }
  const pathValue = env.PATH ?? ""
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
  const hasExtension = Boolean(win32.extname(server.command))
  const candidates = hasExtension ? [server.command] : extensions.map((extension) => `${server.command}${extension.toLowerCase()}`)
  let executable: string | undefined
  for (const candidate of candidates) {
    if (win32.isAbsolute(candidate)) { executable = candidate; break }
    for (const directory of [cwd, ...pathValue.split(";").filter(Boolean)]) {
      const fullPath = win32.resolve(cwd, directory, candidate)
      try { if (existsSync(fullPath)) { executable = fullPath; break } } catch { /* continue searching the effective child PATH */ }
    }
    if (executable) break
  }
  executable ??= candidates[0]
  const extension = win32.extname(executable).toLowerCase()
  if (extension !== ".cmd" && extension !== ".bat") return { command: executable, args: [...server.args] }
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
  const commandLine = [quote(executable), ...server.args.map(quote)].join(" ")
  return { command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c", commandLine] }
}

/** Explicit, canonical option schema: options.servers is a list of named argv-based language servers. */
export function normalizeLspServers(value: unknown): LspServer[] {
  if (value === undefined) return DEFAULT_SERVERS.map((server) => ({ ...server, args: [...server.args], extensions: [...server.extensions] }))
  if (!Array.isArray(value) || value.length > 32) throw new Error("OpenCode LSP configuration requires an array of at most 32 servers.")
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.name !== "string" || !/^[a-z0-9_-]{1,32}$/i.test(item.name) || typeof item.command !== "string" || !item.command.trim() || !Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string") || !Array.isArray(item.extensions) || !item.extensions.length || item.extensions.some((ext) => typeof ext !== "string" || !/^\.[a-z0-9]+$/i.test(ext))) {
      throw new Error(`Invalid OpenCode LSP server configuration at index ${index}; specify name, command, args, and file extensions.`)
    }
    const languageId = typeof item.languageId === "string" && /^[a-z0-9_-]{1,32}$/i.test(item.languageId) ? item.languageId : item.name
    if (item.env !== undefined && (!isRecord(item.env) || !Object.values(item.env).every((entry) => typeof entry === "string"))) throw new Error(`Invalid environment map for OpenCode LSP server ${item.name}.`)
    const env = item.env as Record<string, string> | undefined
    return { name: item.name, command: item.command, args: item.args as string[], extensions: item.extensions as string[], languageId, ...(env ? { env } : {}) }
  })
}

export function selectLspServer(servers: readonly LspServer[], path: string, requested?: string): LspServer {
  if (requested) {
    const selected = servers.find((server) => server.name === requested)
    if (!selected) throw new Error(`Unknown LSP server ${JSON.stringify(requested)}.`)
    return selected
  }
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase()
  const selected = servers.find((server) => server.extensions.some((item) => item.toLowerCase() === extension))
  if (!selected) throw new Error(`No configured LSP server handles ${extension || "this file"}.`)
  return selected
}

export function selectLspServers(servers: readonly LspServer[], path: string, requested?: string | readonly string[]): LspServer[] {
  if (requested) {
    const names = typeof requested === "string" ? [requested] : [...requested]
    if (!names.length) throw new Error("Select at least one LSP server.")
    return names.map((name) => {
      const server = servers.find((candidate) => candidate.name === name)
      if (!server) throw new Error(`Unknown LSP server ${JSON.stringify(name)}.`)
      return server
    })
  }
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase()
  const matching = servers.filter((server) => server.extensions.some((item) => item.toLowerCase() === extension))
  if (!matching.length) throw new Error(`No configured LSP server handles ${extension || "this file"}.`)
  return matching
}

export async function runDiagnostics(server: LspServer, root: string, paths: readonly string[], signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<LspResult[]> {
  const files = await resolveDiagnosticFiles(root, paths, server.extensions)
  if (files.length > MAX_FILES) throw new Error(`LSP diagnostics are limited to ${MAX_FILES} files per call.`)
  if (files.length === 0) return []
  const results: LspResult[] = []
  const client = await LspClient.start(server, root, timeoutMs, signal)
  try {
    for (const file of files) {
      signal?.throwIfAborted()
      const content = await readSafeText(root, file)
      const uri = pathToUri(file)
      client.notify("textDocument/didOpen", { textDocument: { uri, languageId: server.languageId, version: 1, text: content } })
      const capabilities = client.capabilities
      let diagnostics: Diagnostic[] = []
      if (isRecord(capabilities.diagnosticProvider)) {
        const report = await client.request("textDocument/diagnostic", { textDocument: { uri } })
        if (isRecord(report) && Array.isArray(report.items)) diagnostics = report.items as Diagnostic[]
        // rust-analyzer can publish a fresher push result shortly after its initial pull response.
        if (!diagnostics.length && server.name === "rust") diagnostics = await client.waitForDiagnostics(uri, Math.min(timeoutMs, 500))
      } else {
        diagnostics = await client.waitForDiagnostics(uri, Math.min(timeoutMs, 3_000))
      }
      results.push({ path: relative(await realpath(root), file).split(sep).join("/"), server: server.name, diagnostics })
    }
  } finally { await client.stop() }
  return results
}

export async function runFix(server: LspServer, root: string, path: string, kind = "source.fixAll", write = false, signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const file = await resolveOneFile(root, path)
  const content = await readSafeText(root, file)
  const client = await LspClient.start(server, root, timeoutMs, signal)
  try {
    const uri = pathToUri(file)
    client.notify("textDocument/didOpen", { textDocument: { uri, languageId: server.languageId, version: 1, text: content } })
    let diagnostics: Diagnostic[] = []
    if (isRecord(client.capabilities.diagnosticProvider)) {
      const report = await client.request("textDocument/diagnostic", { textDocument: { uri } })
      if (isRecord(report) && Array.isArray(report.items)) diagnostics = report.items as Diagnostic[]
      if (!diagnostics.length && server.name === "rust") diagnostics = await client.waitForDiagnostics(uri, Math.min(timeoutMs, 500))
    } else diagnostics = await client.waitForDiagnostics(uri, Math.min(timeoutMs, 3_000))
    signal?.throwIfAborted()
    const lines = content.split("\n")
    const lastLine = Math.max(0, lines.length - 1)
    const result = await client.request("textDocument/codeAction", {
      textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: lastLine, character: lines[lastLine]?.replace(/\r$/u, "").length ?? 0 } },
      context: { diagnostics, only: [kind], triggerKind: 1 },
    })
    const actions = Array.isArray(result) ? result.filter(isRecord) : []
    const edits = actions.flatMap((action) => normalizeWorkspaceEdits(action.edit, uri))
    const updated = applyTextEdits(content, edits)
    if (write && updated !== content) await queueFileWrite(file, updated, (await lstat(file)).mode & 0o777)
    return { path: relative(await realpath(root), file).split(sep).join("/"), server: server.name, kind, actions: actions.map((action) => typeof action.title === "string" ? action.title : "Source action"), changed: updated !== content, written: write && updated !== content, preview: updated === content ? undefined : updated.slice(0, MAX_OUTPUT) }
  } finally { await client.stop() }
}

export function applyTextEdits(text: string, edits: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>): string {
  const lines = text.split("\n")
  const offset = (position: { line: number; character: number }) => {
    if (!Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.line >= lines.length || position.character < 0) throw new Error("LSP server returned an invalid text edit range.")
    return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + Math.min(position.character, lines[position.line]!.length)
  }
  const sorted = edits.map((edit) => ({ start: offset(edit.range.start), end: offset(edit.range.end), text: edit.newText })).sort((a, b) => b.start - a.start || b.end - a.end)
  let result = text
  let priorStart = result.length + 1
  for (const edit of sorted) {
    if (edit.end < edit.start || edit.end > result.length || edit.end > priorStart) throw new Error("LSP server returned overlapping or invalid text edits.")
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
    priorStart = edit.start
  }
  return result
}

export async function registerLsp(context: PluginContext): Promise<void> {
  const raw = context.options as { servers?: unknown; timeoutMs?: unknown }
  const servers = normalizeLspServers(raw.servers)
  const timeout = typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) ? Math.max(1_000, Math.min(raw.timeoutMs, 60_000)) : DEFAULT_TIMEOUT_MS
  await context.tool.transform((editor) => {
    editor.add({
      name: "lsp_diagnostics", description: "Get diagnostics from configured language servers for project files.",
      input: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, maxItems: MAX_FILES }, root: { type: "string" }, server: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }] } }, additionalProperties: false },
      execute: async (input, call) => {
        const args = input as { paths?: string[]; root?: string; server?: string | string[] }
        const root = resolve(context.location.directory, args.root ?? ".")
        const paths = args.paths?.length ? args.paths : ["."]
        if (paths.includes(".")) {
          const selected = args.server ? (Array.isArray(args.server) ? args.server : [args.server]).map((name) => {
            const found = servers.find((entry) => entry.name === name)
            if (!found) throw new Error(`Unknown LSP server ${JSON.stringify(name)}.`)
            return found
          }) : servers
          const all: LspResult[] = []
          const skipped: string[] = []
          for (const server of selected) {
            const files = await listFiles(root, server.extensions, MAX_FILES - all.length)
            try { for (const file of files) all.push(...await runDiagnostics(server, root, [file], call.signal, timeout)) }
            catch (error) { if (!args.server && isMissingExecutable(error)) skipped.push(server.name); else throw error }
          }
          return resultText(all, skipped)
        }
        const groups = new Map<string, { server: LspServer; files: string[] }>()
        for (const path of paths) {
          for (const server of selectLspServers(servers, path, args.server)) {
            const group = groups.get(server.name) ?? { server, files: [] }
            group.files.push(path); groups.set(server.name, group)
          }
        }
        const all: LspResult[] = []
        const skipped: string[] = []
        for (const { server, files } of groups.values()) {
          try { all.push(...await runDiagnostics(server, root, files, call.signal, timeout)) }
          catch (error) { if (!args.server && isMissingExecutable(error)) skipped.push(server.name); else throw error }
        }
        return resultText(all, skipped)
      },
    })
    editor.add({
      name: "lsp_fix", description: "Preview or apply configured LSP source fixes and import organization.",
      input: { type: "object", properties: { path: { type: "string" }, root: { type: "string" }, server: { type: "string" }, kind: { type: "string" }, write: { type: "boolean" } }, required: ["path"], additionalProperties: false },
      execute: async (input, call) => {
        const args = input as { path: string; root?: string; server?: string; kind?: string; write?: boolean }
        const server = selectLspServer(servers, args.path, args.server)
        const root = resolve(context.location.directory, args.root ?? ".")
        const result = await runFix(server, root, args.path, args.kind ?? "source.fixAll", args.write ?? false, call.signal, timeout)
        return { content: `${result.actions.length ? result.actions.join("\n") : "No source actions available."}${result.changed ? `\n\n${result.written ? "Applied" : "Preview"} for ${result.path}.` : ""}`, metadata: result }
      },
    })
  })
}

function resultText(results: LspResult[], skipped: string[] = []) {
  const items = results.flatMap((result) => result.diagnostics.map((diagnostic) => {
    const start = diagnostic.range?.start
    const severity = diagnostic.severity === 1 ? "error" : diagnostic.severity === 2 ? "warning" : diagnostic.severity === 3 ? "info" : "hint"
    return `${result.path}:${(start?.line ?? 0) + 1}:${(start?.character ?? 0) + 1} ${severity}${diagnostic.code !== undefined ? ` [${typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code}]` : ""}: ${sanitize(String(diagnostic.message ?? ""))}`
  }))
  const text = [items.length ? items.join("\n") : `No diagnostics from ${results.length} file(s).`, ...(skipped.length ? [`Skipped unavailable default server(s): ${skipped.join(", ")}.`] : [])].join("\n\n")
  return { content: text.slice(0, MAX_OUTPUT), metadata: { files: results.length, diagnostics: items.length, skipped } }
}

class LspClient {
  #child: ChildProcessWithoutNullStreams
  readonly timeout: number
  readonly root: string
  #buffer = Buffer.alloc(0)
  #next = 1
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  #diagnostics = new Map<string, Diagnostic[]>()
  #diagnosticWaiters = new Set<(value: Diagnostic[]) => void>()
  #stderr = ""
  #abortCleanup: (() => void) | undefined
  capabilities: Record<string, unknown> = {}
  private constructor(child: ChildProcessWithoutNullStreams, timeout: number, root: string) {
    this.#child = child
    this.timeout = timeout
    this.root = root
    child.stdout.on("data", (chunk: Buffer) => { this.#buffer = Buffer.concat([this.#buffer, chunk]); this.#read() })
    child.stderr.on("data", (chunk: Buffer) => { this.#stderr = (this.#stderr + chunk.toString()).slice(-8_000) })
    child.once("close", (code) => { for (const request of this.#pending.values()) { clearTimeout(request.timer); request.reject(new Error(`Language server exited (${code ?? "unknown"}): ${this.#stderr.trim()}`)) }; this.#pending.clear() })
    child.once("error", (error) => { for (const request of this.#pending.values()) { clearTimeout(request.timer); request.reject(error) }; this.#pending.clear() })
  }
  static async start(server: LspServer, root: string, timeout: number, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const childEnv = { ...process.env, ...server.env }
    const launch = resolveServerLaunch(server, root, process.platform, childEnv)
    const child = spawn(launch.command, launch.args, { cwd: root, env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    const client = new LspClient(child, timeout, root)
    const onAbort = () => child.kill("SIGTERM")
    signal?.addEventListener("abort", onAbort, { once: true })
    client.#abortCleanup = () => signal?.removeEventListener("abort", onAbort)
    try {
      const response = await client.request("initialize", { processId: process.pid, rootUri: pathToUri(root), capabilities: { textDocument: { diagnostic: { dynamicRegistration: false } } }, workspaceFolders: [{ uri: pathToUri(root), name: root.split(/[\\/]/).at(-1) ?? "workspace" }] })
      if (isRecord(response) && isRecord(response.capabilities)) client.capabilities = response.capabilities
      client.notify("initialized", {})
      return client
    } catch (error) { client.#abortCleanup?.(); client.#abortCleanup = undefined; child.kill("SIGTERM"); throw error }
  }
  notify(method: string, params: unknown) { this.#write({ jsonrpc: "2.0", method, params }) }
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.#next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`Language server request timed out: ${method}`)) }, this.timeout)
      this.#pending.set(id, { resolve, reject, timer })
      this.#write({ jsonrpc: "2.0", id, method, params })
    })
  }
  waitForDiagnostics(uri: string, timeout: number): Promise<Diagnostic[]> {
    const current = this.#diagnostics.get(uri)
    if (current) return Promise.resolve(current)
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.#diagnosticWaiters.delete(done); resolve([]) }, timeout)
      const done = (items: Diagnostic[]) => { clearTimeout(timer); this.#diagnosticWaiters.delete(done); resolve(items) }
      this.#diagnosticWaiters.add(done)
    })
  }
  async stop() {
    this.#abortCleanup?.(); this.#abortCleanup = undefined
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return
    try { await this.request("shutdown", null) } catch { /* server may not implement graceful shutdown */ }
    this.notify("exit", null)
    await new Promise<void>((resolve) => {
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) return resolve()
      const timer = setTimeout(() => { this.#child.kill("SIGTERM") }, 800)
      this.#child.once("close", () => { clearTimeout(timer); resolve() })
    })
  }
  #write(message: Record<string, unknown>) {
    const body = Buffer.from(JSON.stringify(message))
    this.#child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    this.#child.stdin.write(body)
  }
  #read() {
    while (true) {
      const split = this.#buffer.indexOf("\r\n\r\n")
      if (split < 0) return
      const header = this.#buffer.subarray(0, split).toString("ascii")
      const length = /Content-Length:\s*(\d+)/i.exec(header)?.[1]
      if (!length) { this.#buffer = this.#buffer.subarray(split + 4); continue }
      const size = Number(length)
      if (!Number.isSafeInteger(size) || size > 4_000_000) { this.#child.kill("SIGTERM"); return }
      if (this.#buffer.length < split + 4 + size) return
      const body = this.#buffer.subarray(split + 4, split + 4 + size)
      this.#buffer = this.#buffer.subarray(split + 4 + size)
      let message: unknown
      try { message = JSON.parse(body.toString("utf8")) } catch { continue }
      if (!isRecord(message)) continue
      if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
        this.#respondToServerRequest(message.id, message.method, message.params)
      } else if (typeof message.id === "number") {
        const request = this.#pending.get(message.id)
        if (!request) continue
        this.#pending.delete(message.id); clearTimeout(request.timer)
        if (message.error) request.reject(new Error(`Language server error: ${sanitize(JSON.stringify(message.error))}`))
        else request.resolve(message.result)
      } else if (message.method === "textDocument/publishDiagnostics" && isRecord(message.params) && typeof message.params.uri === "string") {
        const items = Array.isArray(message.params.diagnostics) ? message.params.diagnostics as Diagnostic[] : []
        this.#diagnostics.set(message.params.uri, items)
        for (const waiter of [...this.#diagnosticWaiters]) waiter(items)
      }
    }
  }
  #respondToServerRequest(id: number | string, method: string, params: unknown) {
    let result: unknown = null
    if (method === "workspace/configuration") result = isRecord(params) && Array.isArray(params.items) ? params.items.map(() => ({})) : []
    else if (method === "workspace/workspaceFolders") result = [{ uri: pathToUri(this.root), name: this.root.split(/[\\/]/).at(-1) ?? "workspace" }]
    else if (method === "workspace/applyEdit") result = { applied: false, failureReason: "The OpenCode LSP tool does not apply server initiated edits." }
    else if (!["client/registerCapability", "client/unregisterCapability", "window/workDoneProgress/create", "window/showMessageRequest", "workspace/diagnostic/refresh", "textDocument/diagnostic/refresh", "workspace/semanticTokens/refresh"].includes(method)) {
      this.#write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not supported by the OpenCode LSP adapter." } })
      return
    }
    this.#write({ jsonrpc: "2.0", id, result })
  }
}

async function resolveDiagnosticFiles(root: string, paths: readonly string[], extensions: readonly string[]) {
  const canonicalRoot = await realpath(root)
  const files: string[] = []
  for (const path of paths) {
    if (!path || isAbsolute(path) || path.includes("\0")) throw new Error("LSP paths must be relative to the workspace root.")
    const candidate = resolve(canonicalRoot, path)
    if (!within(canonicalRoot, candidate)) throw new Error("LSP path is outside the workspace root.")
    const info = await lstat(candidate)
    if (info.isSymbolicLink()) throw new Error("LSP does not follow symbolic links.")
    if (info.isDirectory()) {
      await collectFiles(canonicalRoot, candidate, extensions, files, MAX_FILES + 1, 0)
    } else files.push(await resolveOneFile(root, path))
    if (files.length > MAX_FILES) throw new Error(`LSP diagnostics are limited to ${MAX_FILES} files per call.`)
  }
  return [...new Set(files)]
}
async function resolveOneFile(root: string, path: string) {
  if (!path || isAbsolute(path) || path.includes("\0")) throw new Error("LSP paths must be relative to the workspace root.")
  const canonicalRoot = await realpath(root), candidate = resolve(canonicalRoot, path)
  if (!within(canonicalRoot, candidate)) throw new Error("LSP path is outside the workspace root.")
  const entry = await lstat(candidate)
  if (entry.isSymbolicLink()) throw new Error("LSP does not follow symbolic links.")
  const file = await realpath(candidate)
  if (!within(canonicalRoot, file) || !(await lstat(file)).isFile()) throw new Error("LSP only opens regular files inside the workspace.")
  return file
}
async function readSafeText(root: string, file: string) {
  const info = await lstat(file)
  if (info.size > MAX_FILE_BYTES) throw new Error(`LSP file exceeds ${MAX_FILE_BYTES} bytes.`)
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try { const opened = await handle.stat(); if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("LSP file changed while opening."); const buffer = Buffer.alloc(MAX_FILE_BYTES + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); if (bytesRead > MAX_FILE_BYTES) throw new Error("LSP file is too large."); const bytes = buffer.subarray(0, bytesRead); if (bytes.includes(0)) throw new Error("LSP only supports text files."); return bytes.toString("utf8") } finally { await handle.close() }
}
async function listFiles(root: string, extensions: readonly string[], limit: number): Promise<string[]> {
  if (limit <= 0) return []
  const output: string[] = []
  async function visit(dir: string, depth: number) {
    if (depth > 6 || output.length >= limit) return
    let entries; try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (output.length >= limit) break
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".opencode") continue
      const path = resolve(dir, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path, depth + 1)
      else if (entry.isFile() && extensions.includes(path.slice(path.lastIndexOf(".")))) output.push(relative(root, path))
    }
  }
  await visit(root, 0); return output
}
async function collectFiles(root: string, dir: string, extensions: readonly string[], files: string[], limit: number, depth: number) {
  if (depth > 8 || files.length >= limit) return
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (files.length >= limit) return
    if ([".git", "node_modules", ".opencode"].includes(entry.name)) continue
    const file = resolve(dir, entry.name)
    if (entry.isDirectory() && !entry.isSymbolicLink()) await collectFiles(root, file, extensions, files, limit, depth + 1)
    else if (entry.isFile() && extensions.some((extension) => file.toLowerCase().endsWith(extension.toLowerCase()))) files.push(file)
  }
}
const fileQueues = new Map<string, Promise<void>>()
async function queueFileWrite(path: string, text: string, mode: number) {
  const previous = fileQueues.get(path) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(async () => {
    const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode })
      await rename(temporary, path)
    } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error }
  })
  fileQueues.set(path, current)
  try { await current } finally { if (fileQueues.get(path) === current) fileQueues.delete(path) }
}
function normalizeWorkspaceEdits(value: unknown, uri: string) {
  if (!isRecord(value)) return []
  const changes = Array.isArray(value.documentChanges) ? value.documentChanges : undefined
  let raw: unknown[] = []
  if (isRecord(value.changes) && Array.isArray(value.changes[uri])) raw = value.changes[uri] as unknown[]
  if (changes) for (const change of changes) if (isRecord(change) && isRecord(change.textDocument) && change.textDocument.uri === uri && Array.isArray(change.edits)) raw.push(...change.edits)
  return raw.flatMap((item) => { if (!isRecord(item) || !isRecord(item.range) || !isRecord(item.range.start) || !isRecord(item.range.end) || typeof item.newText !== "string") return []; const range = item.range; const start = range.start, end = range.end; if (typeof start.line !== "number" || typeof start.character !== "number" || typeof end.line !== "number" || typeof end.character !== "number") return []; return [{ range: { start: { line: start.line, character: start.character }, end: { line: end.line, character: end.character } }, newText: item.newText }] })
}
function pathToUri(path: string) { return new URL(`file://${path.startsWith("/") ? "" : "/"}${path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/")}`).href }
function within(root: string, path: string) { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) }
function sanitize(value: string) { return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 4_000) }
function isMissingExecutable(error: unknown) { return isRecord(error) && error.code === "ENOENT" }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value) }
