import type { PluginContext } from "./plugin-types.ts";
import { workflowTransition } from "./workflow-lock.ts";
import { type GoalState, goalActiveSeconds } from "./workflow-state.ts";

export interface GoalSettings {
  automaticTurns: number | null;
  noProgressTurns: number | null;
}

interface GoalSettingsRuntime {
  read(sessionID: string): Promise<GoalState | undefined>;
  mutate(
    sessionID: string,
    update: (goal: GoalState | undefined) => GoalState | undefined,
  ): Promise<GoalState | undefined>;
}

const SETTINGS_KEY = "workflow/goal-settings";
const SETTINGS_LOCK = "@goal-settings";
const DEFAULT_SETTINGS: GoalSettings = { automaticTurns: 25, noProgressTurns: 3 };
const limitSchema = {
  anyOf: [{ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, { type: "null" }],
};
const settingsSchema = {
  type: "object",
  properties: { automaticTurns: limitSchema, noProgressTurns: limitSchema },
  required: ["automaticTurns", "noProgressTurns"],
  additionalProperties: false,
};
const snapshotSchema = {
  type: "object",
  properties: {
    goal: { anyOf: [{ type: "object" }, { type: "null" }] },
    settings: settingsSchema,
    elapsedMs: { type: "integer", minimum: 0 },
  },
  required: ["goal", "settings", "elapsedMs"],
  additionalProperties: false,
};
const sessionSchema = { type: "string", minLength: 1, maxLength: 200 };

export const goalRPC = {
  id: "romm0109.goal",
  methods: {
    get: {
      input: {
        type: "object",
        properties: { sessionID: sessionSchema },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: snapshotSchema,
    },
    configure: {
      input: {
        type: "object",
        properties: {
          sessionID: sessionSchema,
          automaticTurns: limitSchema,
          noProgressTurns: limitSchema,
        },
        required: ["sessionID", "automaticTurns", "noProgressTurns"],
        additionalProperties: false,
      },
      output: snapshotSchema,
    },
  },
  events: {},
};

function isLimit(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Caller holds SETTINGS_LOCK; malformed documents must never be replaced with defaults. */
async function readStoredSettings(ctx: Pick<PluginContext, "storage">) {
  const stored = await ctx.storage.get(SETTINGS_KEY);
  if (stored === undefined) return { stored, settings: { ...DEFAULT_SETTINGS } };
  if (!object(stored) || !isLimit(stored.automaticTurns) || !isLimit(stored.noProgressTurns))
    throw new Error("Goal settings are invalid; refusing to overwrite them.");
  return {
    stored,
    settings: {
      automaticTurns: stored.automaticTurns,
      noProgressTurns: stored.noProgressTurns,
    },
  };
}

/** In-process ordering shares the same global lock as RPC saves and rollbacks. */
export function readGoalSettings(ctx: Pick<PluginContext, "storage">): Promise<GoalSettings> {
  return workflowTransition(ctx.storage, SETTINGS_LOCK, async () => (await readStoredSettings(ctx)).settings);
}

function inputSession(input: unknown, configure = false): string {
  const allowed = configure ? ["sessionID", "automaticTurns", "noProgressTurns"] : ["sessionID"];
  if (
    !object(input) ||
    typeof input.sessionID !== "string" ||
    !input.sessionID.trim() ||
    input.sessionID.length > 200 ||
    input.sessionID === SETTINGS_LOCK ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw new Error("Invalid Goal settings request: provide a sessionID.");
  return input.sessionID;
}

function snapshot(goal: GoalState | undefined, settings: GoalSettings) {
  return { goal: goal ?? null, settings, elapsedMs: goal ? Math.floor(goalActiveSeconds(goal) * 1000) : 0 };
}

export async function registerGoalSettings(ctx: PluginContext, runtime: GoalSettingsRuntime) {
  return ctx.rpc.register(goalRPC, {
    get: async (input, call) => {
      const sessionID = inputSession(input);
      return workflowTransition(ctx.storage, sessionID, () =>
        workflowTransition(ctx.storage, SETTINGS_LOCK, async () => {
          call?.signal.throwIfAborted();
          const { settings } = await readStoredSettings(ctx);
          call?.signal.throwIfAborted();
          const goal = await runtime.read(sessionID);
          call?.signal.throwIfAborted();
          return snapshot(goal, settings);
        }),
      );
    },
    configure: async (input, call) => {
      const sessionID = inputSession(input, true);
      if (!object(input) || !isLimit(input.automaticTurns) || !isLimit(input.noProgressTurns))
        throw new Error("Goal safety limits must be positive safe integers or null to disable them.");
      const settings: GoalSettings = { automaticTurns: input.automaticTurns, noProgressTurns: input.noProgressTurns };
      // Commands acquire the session lock before reading global settings; preserve
      // that lock order here. The global lock remains held through any rollback.
      return workflowTransition(ctx.storage, sessionID, () =>
        workflowTransition(ctx.storage, SETTINGS_LOCK, async () => {
          call.signal.throwIfAborted();
          const previous = await readStoredSettings(ctx);
          call.signal.throwIfAborted();
          const selected = await runtime.read(sessionID);
          call.signal.throwIfAborted();
          await ctx.storage.set(SETTINGS_KEY, { ...previous.stored, ...settings });
          let applied = false;
          let previousGoal: GoalState | undefined;
          try {
            call.signal.throwIfAborted();
            const goal = selected
              ? await runtime.mutate(sessionID, (current) => {
                  call.signal.throwIfAborted();
                  previousGoal = current;
                  return current
                    ? {
                        ...current,
                        automaticTurnLimit: settings.automaticTurns,
                        noProgressTurnLimit: settings.noProgressTurns,
                      }
                    : current;
                })
              : undefined;
            applied = true;
            call.signal.throwIfAborted();
            return snapshot(goal, settings);
          } catch (error) {
            const failures: unknown[] = [error];
            // Cancellation can arrive while the selected Goal write is pending.
            // Restore only our fields, retaining any later accounting updates.
            if (applied && previousGoal) {
              const before = previousGoal;
              try {
                await runtime.mutate(sessionID, (current) =>
                  current?.id === before.id &&
                  current.automaticTurnLimit === settings.automaticTurns &&
                  current.noProgressTurnLimit === settings.noProgressTurns
                    ? {
                        ...current,
                        automaticTurnLimit: before.automaticTurnLimit,
                        noProgressTurnLimit: before.noProgressTurnLimit,
                      }
                    : current,
                );
              } catch (rollbackError) {
                failures.push(rollbackError);
              }
            }
            try {
              if (previous.stored === undefined) await ctx.storage.remove(SETTINGS_KEY);
              else await ctx.storage.set(SETTINGS_KEY, previous.stored);
            } catch (rollbackError) {
              failures.push(rollbackError);
            }
            if (failures.length > 1)
              throw new AggregateError(
                failures,
                "Goal settings update and rollback failed; reload settings to inspect them.",
              );
            throw error;
          }
        }),
      );
    },
  });
}
