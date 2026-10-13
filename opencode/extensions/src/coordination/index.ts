import type { PluginContext } from "../plugin-types.ts"
import { registerBtw } from "./btw.ts"
import { SessionJobRegistry } from "./coordination.ts"
import { registerFleet } from "./fleet.ts"
import { registerHerdr } from "./herdr.ts"
import { registerSubagents } from "./subagents.ts"

/** Server-plugin registration entry for the session coordination group. */
export async function registerCoordinationGroup(ctx: PluginContext): Promise<() => Promise<void>> {
  const jobs = new SessionJobRegistry(ctx.session, ctx.storage)
  const controller = new AbortController()
  let eventTask: Promise<void> | undefined
  await Promise.all([
    registerBtw(ctx, jobs),
    registerFleet(ctx, jobs),
    registerHerdr(ctx),
    registerSubagents(ctx, jobs),
  ])
  eventTask = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "session.deleted") continue
        const id = event.data.sessionID
        await jobs.disposeParent(id)
        await jobs.disposeChild(id)
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error("Coordination lifecycle observer stopped", error)
    }
  })()
  return async () => {
    controller.abort()
    await eventTask
    await jobs.close()
  }
}

export { SessionJobRegistry } from "./coordination.ts"
export { availableFleetTransports } from "./fleet.ts"
export { parseHerdrAgentList, requestHerdrAgents } from "./herdr.ts"
export { createCoordinationTui } from "./tui.ts"
