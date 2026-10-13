import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import process from "node:process"
import type { PluginContext } from "../plugin-types.ts"

export type CaffeinateMode = "display" | "sleep"
export type Inhibitor = { stop(): Promise<void> | void }
export type InhibitorDriver = (mode: CaffeinateMode) => Promise<Inhibitor | undefined>

/** Small state machine kept separate from platform calls so lifecycle cleanup is fixture-testable. */
export class CaffeinateController {
  readonly #driver: InhibitorDriver
  #sessions = new Set<string>()
  #enabled = true
  #mode: CaffeinateMode = "display"
  #inhibitorMode: CaffeinateMode | undefined
  #inhibitor: Inhibitor | undefined
  #starting: Promise<void> | undefined
  constructor(driver: InhibitorDriver) { this.#driver = driver }
  get enabled() { return this.#enabled }
  get mode() { return this.#mode }
  get activeCount() { return this.#sessions.size }
  setEnabled(enabled: boolean) { this.#enabled = enabled; return this.#reconcile() }
  setMode(mode: CaffeinateMode) { this.#mode = mode; return this.#reconcile() }
  async event(type: string, sessionID: string) {
    if (type === "session.execution.started") this.#sessions.add(sessionID)
    if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(type)) this.#sessions.delete(sessionID)
    await this.#reconcile()
  }
  async shutdown() { this.#sessions.clear(); await this.#stop() }
  async #reconcile(): Promise<void> {
    if (this.#enabled && this.#sessions.size) {
      if (this.#starting) { await this.#starting; return this.#reconcile() }
      if (this.#inhibitor && this.#inhibitorMode === this.#mode) return
      if (this.#inhibitor) await this.#stop()
      const requestedMode = this.#mode
      const starting = (async () => {
        const inhibitor = await this.#driver(requestedMode)
        if (!this.#enabled || !this.#sessions.size || this.#mode !== requestedMode) await inhibitor?.stop()
        else { this.#inhibitor = inhibitor; this.#inhibitorMode = requestedMode }
      })()
      this.#starting = starting
      try { await starting } finally { if (this.#starting === starting) this.#starting = undefined }
      if (this.#enabled && this.#sessions.size && this.#mode !== requestedMode) await this.#reconcile()
    } else {
      if (this.#starting) await this.#starting
      if (!this.#sessions.size || !this.#enabled) await this.#stop()
    }
  }
  async #stop() {
    const inhibitor = this.#inhibitor
    this.#inhibitor = undefined
    this.#inhibitorMode = undefined
    await inhibitor?.stop()
  }
}

export const defaultInhibitorDriver: InhibitorDriver = async (mode) => {
  const command = resolveInhibitorCommand(mode)
  if (!command) return undefined
  const child = spawn(command.command, command.args, {
    stdio: [command.releaseOnStdinClose ? "pipe" : "ignore", "ignore", "ignore"],
    windowsHide: true,
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    child.once("spawn", () => { child.removeListener("error", onError); resolve() })
    child.once("error", onError)
  })
  let done = false
  child.once("close", () => { done = true })
  return { stop: () => stopChild(child, command, () => done) }
}

export async function registerCaffeinate(context: PluginContext, driver: InhibitorDriver = defaultInhibitorDriver): Promise<() => Promise<void>> {
  const controller = new CaffeinateController(driver)
  const stored = await context.storage.get("romm0109.caffeinate.v1")
  if (isRecord(stored)) {
    if (stored.mode === "sleep" || stored.mode === "display") await controller.setMode(stored.mode)
    if (typeof stored.enabled === "boolean") await controller.setEnabled(stored.enabled)
  }
  const abort = new AbortController()
  const consume = async () => {
    try {
      for await (const event of context.event.subscribe({ signal: abort.signal })) {
        if (event.type.startsWith("session.execution.")) {
          const data = event.data as { sessionID?: string }
          if (data.sessionID) await controller.event(event.type, data.sessionID)
        }
      }
    } catch (error) { if (!abort.signal.aborted) console.error("OpenCode caffeinate event stream stopped", error) }
  }
  const consumeTask = consume()
  await context.command.transform((editor) => editor.add({
    name: "caffeinate",
    description: "Control keep-awake behavior while OpenCode runs a session",
    execute: async ({ sessionID, prompt }) => {
      const arg = prompt.text.replace(/^\/caffeinate\s*/i, "").trim()
      if (!arg || arg === "status") {
        const state = `${controller.enabled ? "enabled" : "disabled"}; mode=${controller.mode}; active executions=${controller.activeCount}`
        await context.session.synthetic({ sessionID, text: `Caffeinate ${state}.`, resume: false }); return
      }
      if (arg === "on" || arg === "off") {
        await savePreferences(context, controller, { enabled: arg === "on", mode: controller.mode })
        await context.session.synthetic({ sessionID, text: `Automatic keep-awake is ${arg}.`, resume: false }); return
      }
      if (arg === "display" || arg === "sleep") {
        await savePreferences(context, controller, { enabled: controller.enabled, mode: arg })
        await context.session.synthetic({ sessionID, text: `Keep-awake mode set to ${arg}.`, resume: false }); return
      }
      throw new Error("Usage: /caffeinate [status | on | off | display | sleep]")
    },
  }))
  return async () => { abort.abort(); await controller.shutdown(); await consumeTask }
}

async function savePreferences(context: PluginContext, controller: CaffeinateController, next: { enabled: boolean; mode: CaffeinateMode }) {
  const previous = { enabled: controller.enabled, mode: controller.mode }
  try {
    await controller.setMode(next.mode)
    await controller.setEnabled(next.enabled)
    await context.storage.set("romm0109.caffeinate.v1", next)
  } catch (error) {
    await controller.setMode(previous.mode)
    await controller.setEnabled(previous.enabled)
    throw error
  }
}

type Command = { command: string; args: string[]; releaseOnStdinClose?: boolean }
export function resolveInhibitorCommand(mode: CaffeinateMode, platform = process.platform): Command | undefined {
  if (platform === "darwin") return unixBound("caffeinate", mode === "display" ? ["-dimsu"] : ["-ims"])
  if (platform === "win32") return { command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", windowsScript(mode)], releaseOnStdinClose: true }
  if (platform === "linux") {
    if (process.env.WSL_DISTRO_NAME && commandExists("powershell.exe")) return { command: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", windowsScript(mode)], releaseOnStdinClose: true }
    if (commandExists("systemd-inhibit")) return unixBound("systemd-inhibit", [`--what=${mode === "display" ? "idle:sleep" : "sleep"}`, "--who=opencode-caffeinate", "--why=OpenCode session is running", "--mode=block", "sleep", "infinity"])
    if (commandExists("caffeinate")) return unixBound("caffeinate", mode === "display" ? ["-dimsu"] : ["-ims"])
  }
  return undefined
}
function unixBound(command: string, args: string[]): Command {
  const script = `parent=$1; shift; "$@" & child=$!; ( while kill -0 "$parent" 2>/dev/null; do sleep 5; done; kill "$child" 2>/dev/null ) & watcher=$!; cleanup() { kill "$watcher" 2>/dev/null; kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; }; trap 'cleanup; exit 0' INT TERM HUP EXIT; wait "$child"; status=$?; kill "$watcher" 2>/dev/null; trap - EXIT; exit "$status"`
  return { command: "sh", args: ["-c", script, "opencode-caffeinate-watch", String(process.pid), command, ...args] }
}
function windowsScript(mode: CaffeinateMode) {
  const flags = mode === "sleep" ? "0x80000001" : "0x80000003"
  return `$ErrorActionPreference='Stop'; Add-Type -Namespace Native -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'; $flags=[uint32]'${flags}'; $release=[uint32]'0x80000000'; $stdin=[Console]::OpenStandardInput(); $buffer=New-Object byte[] 1; $readTask=$stdin.ReadAsync($buffer,0,1); try { while ($true) { [Native.Power]::SetThreadExecutionState($flags) | Out-Null; if ($readTask.Wait(30000)) { break } } } finally { [Native.Power]::SetThreadExecutionState($release) | Out-Null }`
}
function commandExists(name: string) {
  const path = process.env.PATH ?? ""
  return path.split(process.platform === "win32" ? ";" : ":").some((directory) => directory && ["", ".exe", ".cmd", ".bat"].some((ext) => existsSync(`${directory}/${name}${ext}`)))
}
function stopChild(child: ChildProcess, command: Command, isDone: () => boolean): Promise<void> {
  if (isDone()) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (!isDone()) child.kill() }, 2_000)
    child.once("close", () => { clearTimeout(timer); resolve() })
    if (command.releaseOnStdinClose && child.stdin && !child.stdin.destroyed) child.stdin.end()
    else child.kill(process.platform === "win32" ? undefined : "SIGTERM")
  })
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
