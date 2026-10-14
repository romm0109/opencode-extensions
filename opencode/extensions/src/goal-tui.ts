import type { Context, DialogSelectOption } from "@opencode/plugin/tui/context";
import { stripTerminalControls } from "./terminal-presentation.ts";
import { canResumeGoal, type GoalState, parseGoalCommand, parseTokenBudget, validGoalState } from "./workflow-state.ts";

const RPC_ID = "romm0109.goal";
type LimitField = "automaticTurns" | "noProgressTurns";
type Settings = Record<LimitField, number | null>;
export type GoalSnapshot = { goal: GoalState | null; settings: Settings; elapsedMs: number };
type Action = "start" | "start-budget" | "edit" | "pause" | "resume" | "clear" | "status" | "settings" | "help";
type Flow = { sessionID: string; controller: AbortController };

const HELP = [
  "/goal-manager opens this session's Goal manager.",
  "/goal <objective> starts work; /goal --tokens 100k <objective> adds a cumulative token budget.",
  "/goal edit [--tokens 100k] <objective> edits the current goal; /goal pause, resume, status, and clear remain available.",
  "Pause and clear interrupt the current turn. Clear removes the saved goal. Resume starts a new automatic-work epoch.",
  "Plugin settings change this goal and future goals; other existing goals adopt them when resumed. Unlimited and Off disable only their respective safety guards.",
  "Active elapsed time excludes paused, waiting, and completed time. Status is refreshed whenever a screen opens.",
  "Escape cancels the current dialog. Saved settings stay saved. Close the manager before switching sessions.",
].join("\n\n");

function clean(value: string, limit = 4000): string {
  return [...stripTerminalControls(value)].slice(0, limit).join("");
}

function line(value: string, limit = 220): string {
  return clean(value, limit).replace(/\s+/gu, " ").trim();
}

function activeSession(ctx: Context): string | undefined {
  const route = ctx.ui.router.current();
  return route.type === "session" ? route.sessionID : ctx.ui.tabs.list().find((tab) => tab.active)?.sessionID;
}

function limitValid(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

export function parseGoalLimit(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const number = Number(trimmed);
  return limitValid(number) && number !== null ? number : undefined;
}

function snapshot(value: unknown): GoalSnapshot {
  if (!value || typeof value !== "object") throw new Error("Goal state is unavailable. Check the server plugin.");
  const result = value as Partial<GoalSnapshot>;
  if (
    (result.goal !== null && !validGoalState(result.goal)) ||
    !result.settings ||
    !limitValid(result.settings.automaticTurns) ||
    !limitValid(result.settings.noProgressTurns) ||
    typeof result.elapsedMs !== "number" ||
    !Number.isFinite(result.elapsedMs) ||
    result.elapsedMs < 0
  )
    throw new Error("The server returned invalid Goal state or settings.");
  return result as GoalSnapshot;
}

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function limitLabel(field: LimitField, value: number | null): string {
  return value === null ? (field === "automaticTurns" ? "Unlimited" : "Off") : `${value} responses`;
}

export function goalManagerView(state: GoalSnapshot, running: boolean) {
  const goal = state.goal;
  const owns = goal?.status === "active" || goal?.status === "waiting";
  const disabled = (action: Action): boolean => {
    if (action === "start" || action === "start-budget") return running || owns;
    if (action === "edit") return running || !goal;
    if (action === "pause") return !owns;
    if (action === "resume") return running || !goal || !canResumeGoal(goal);
    if (action === "clear") return !goal;
    return false;
  };
  const options: DialogSelectOption<Action>[] = [
    { value: "start", title: "Start a goal", description: "Enter an objective with no token budget" },
    {
      value: "start-budget",
      title: "Start with token budget",
      description: "Enter an objective and a cumulative token ceiling",
    },
    { value: "edit", title: "Edit goal", description: "Change the objective or increase its token budget" },
    { value: "pause", title: "Pause goal", description: "Save progress and interrupt the current turn" },
    { value: "resume", title: "Resume goal", description: "Continue with a fresh automatic-work epoch" },
    { value: "status", title: "View full status", description: goal ? line(goal.objective) : "No goal is set" },
    {
      value: "settings",
      title: "Settings",
      description: `Plugin defaults · Automatic work: ${limitLabel("automaticTurns", state.settings.automaticTurns)} · No-progress guard: ${limitLabel("noProgressTurns", state.settings.noProgressTurns)}`,
    },
    { value: "help", title: "Help", description: "Commands, safety limits, and cancellation" },
    { value: "clear", title: "Clear goal", description: "Remove the saved goal and interrupt the current turn" },
  ];
  return {
    title: `Goal · ${goal?.status.replaceAll("_", " ") ?? "inactive"} · ${duration(state.elapsedMs)} active${running ? " · session busy" : ""}${goal ? `\n${line(goal.objective, 160)}` : ""}`,
    options: options.map((option) => ({ ...option, disabled: disabled(option.value) })),
  };
}

export function goalDetails(state: GoalSnapshot): string {
  const goal = state.goal;
  return [
    goal
      ? `State: ${goal.status.replaceAll("_", " ")}\nObjective: ${clean(goal.objective)}`
      : "No goal is currently set.",
    `Active elapsed: ${duration(state.elapsedMs)}`,
    `Automatic work: ${goal?.automaticTurns ?? 0} / ${limitLabel("automaticTurns", goal ? goal.automaticTurnLimit : state.settings.automaticTurns)}`,
    `No-progress guard: ${goal?.noProgressTurns ?? 0} / ${limitLabel("noProgressTurns", goal ? (goal.noProgressTurnLimit === undefined ? 3 : goal.noProgressTurnLimit) : state.settings.noProgressTurns)}`,
    `Tokens: ${goal?.tokensUsed ?? 0}${goal?.tokenBudget ? ` / ${goal.tokenBudget}` : " (no budget)"}`,
    ...(goal?.waitingFor ? [`Waiting for: ${clean(goal.waitingFor)}`] : []),
    ...(goal?.resumeAt ? [`Safety wake: ${new Date(goal.resumeAt).toISOString()}`] : []),
    ...(goal?.summary ? [`Summary: ${clean(goal.summary)}`] : []),
    ...(goal?.evidence?.length
      ? [`Evidence:\n${goal.evidence.map((item) => `• ${clean(item, 500)}`).join("\n")}`]
      : []),
    ...(goal?.lastError ? [`Last issue: ${clean(goal.lastError)}`] : []),
  ].join("\n\n");
}

function sameGoal(left: GoalState | null, right: GoalState | null): boolean {
  return left?.id === right?.id && left?.lifecycle === right?.lifecycle && left?.status === right?.status;
}

/**
 * Native OpenCode dialogs intentionally replace Pi's SettingsList. Keeping `current`
 * preserves the selected settings row across immediate saves. The public dialog API
 * has no scoped cancellation handle: the host owns dismissal and keyboard semantics.
 * Never call global dialog.clear() from cleanup; that could dismiss another plugin.
 */
export function createGoalTui() {
  return {
    id: "romm0109.goal.tui",
    setup(ctx: Context) {
      let disposed = false;
      let active: Flow | undefined;
      const isCurrent = (owner: Flow) =>
        !disposed && active === owner && !owner.controller.signal.aborted && activeSession(ctx) === owner.sessionID;
      const assertCurrent = (owner: Flow) => {
        if (isCurrent(owner)) return;
        owner.controller.abort();
        throw new Error("Goal manager cancelled.");
      };
      const wait = async <T>(owner: Flow, action: () => Promise<T>): Promise<T> => {
        assertCurrent(owner);
        let abort: () => void = () => {};
        const cancelled = new Promise<never>((_, reject) => {
          abort = () => reject(new Error("Goal manager cancelled."));
          owner.controller.signal.addEventListener("abort", abort, { once: true });
        });
        try {
          const result = await Promise.race([action(), cancelled]);
          assertCurrent(owner);
          return result;
        } finally {
          owner.controller.signal.removeEventListener("abort", abort);
        }
      };
      const alert = (owner: Flow, title: string, message: string) =>
        wait(owner, () => ctx.ui.dialog.alert({ title: clean(title, 160), message: clean(message, 24_000) }));
      const get = async (owner: Flow) => {
        const result = await wait(owner, () =>
          ctx.client.rpc.call(
            { rpcID: RPC_ID, method: "get", input: { sessionID: owner.sessionID }, location: ctx.location },
            { signal: owner.controller.signal },
          ),
        );
        return snapshot(result.output);
      };
      const unchanged = async (owner: Flow, shown: GoalSnapshot, action: Action) => {
        const latest = await get(owner);
        if (!sameGoal(latest.goal, shown.goal)) {
          await alert(
            owner,
            "Goal changed",
            "The goal changed while this dialog was open. Review the current state and try again.",
          );
          return undefined;
        }
        if (
          goalManagerView(latest, ctx.data.session.status(owner.sessionID) === "running").options.find(
            (option) => option.value === action,
          )?.disabled
        ) {
          await alert(
            owner,
            "Action unavailable",
            "This action is no longer available. Review the current goal or wait for the session to become idle.",
          );
          return undefined;
        }
        return latest;
      };
      const command = async (owner: Flow, text: string) => {
        await wait(owner, () =>
          ctx.client.session.command(
            { sessionID: owner.sessionID, name: "goal", text },
            { signal: owner.controller.signal },
          ),
        );
      };
      const settings = async (owner: Flow) => {
        let selected: LimitField | undefined;
        while (isCurrent(owner)) {
          const shown = await get(owner);
          const field = await wait(owner, () =>
            ctx.ui.dialog.select<LimitField>({
              title: "Goal plugin settings · saves immediately",
              current: selected,
              options: [
                {
                  title: "Automatic-work limit",
                  value: "automaticTurns",
                  description: `${limitLabel("automaticTurns", shown.settings.automaticTurns)} · default 25; applies to current and future goals`,
                },
                {
                  title: "No-progress guard",
                  value: "noProgressTurns",
                  description: `${limitLabel("noProgressTurns", shown.settings.noProgressTurns)} · default 3; pauses repeated or empty tool-free runs`,
                },
              ],
            }),
          );
          if (field === undefined) return;
          if (field !== "automaticTurns" && field !== "noProgressTurns") return;
          selected = field;
          const previous = shown.settings[field];
          const title = field === "automaticTurns" ? "Automatic-work limit" : "No-progress guard";
          const choice = await wait(owner, () =>
            ctx.ui.dialog.select({
              title: `${title} · ${limitLabel(field, previous)}`,
              options: [
                { value: "custom", title: "Set a whole-number limit" },
                { value: "default", title: `Use default (${field === "automaticTurns" ? 25 : 3})` },
                {
                  value: "off",
                  title: field === "automaticTurns" ? "Unlimited" : "Off",
                  description: "Disable this safety guard; other stop conditions still apply",
                },
              ],
            }),
          );
          if (choice === undefined) continue;
          let value: number | null;
          if (choice === "custom") {
            const input = await wait(owner, () =>
              ctx.ui.dialog.prompt({
                title,
                description: "Enter a whole number greater than zero.",
                value: String(previous ?? (field === "automaticTurns" ? 25 : 3)),
              }),
            );
            if (input === undefined) continue;
            const parsed = parseGoalLimit(input);
            if (parsed === undefined) {
              await alert(
                owner,
                "Invalid limit",
                "Enter a whole number greater than zero. Use Unlimited or Off to disable the guard.",
              );
              continue;
            }
            value = parsed;
          } else if (choice === "off") value = null;
          else if (choice === "default") value = field === "automaticTurns" ? 25 : 3;
          else continue;
          if (value === previous) continue;
          if (
            value === null &&
            !(await wait(owner, () =>
              ctx.ui.dialog.confirm({
                title: `Set ${title.toLowerCase()} to ${limitLabel(field, value)}?`,
                message: `This disables the ${title.toLowerCase()} for this goal and future goals. Other existing goals adopt the setting when resumed. Automatic work may run longer and consume more tokens. Other stop conditions still apply.`,
                label: { confirm: "Apply", cancel: "Keep current limit" },
              }),
            ))
          )
            continue;
          const latest = await get(owner);
          if (!sameGoal(shown.goal, latest.goal) || latest.settings[field] !== previous) {
            await alert(
              owner,
              "Settings changed",
              "The goal or this setting changed while the dialog was open. Review the current values and try again.",
            );
            continue;
          }
          const used =
            field === "automaticTurns" ? (latest.goal?.automaticTurns ?? 0) : (latest.goal?.noProgressTurns ?? 0);
          if (value !== null && used >= value && latest.goal?.status === "active") {
            const confirmed = await wait(owner, () =>
              ctx.ui.dialog.confirm({
                title: "Apply a reached safety limit?",
                message: `The current goal has already used ${used} responses against this guard. Setting it to ${value} may pause work immediately.`,
                label: { confirm: "Apply limit", cancel: "Cancel" },
              }),
            );
            if (!confirmed) continue;
          }
          // Read once more after a confirmation, preserving unrelated concurrent edits.
          const current = await get(owner);
          if (!sameGoal(latest.goal, current.goal) || current.settings[field] !== previous) {
            await alert(
              owner,
              "Settings changed",
              "The goal or setting changed. Review the current values and try again.",
            );
            continue;
          }
          try {
            await wait(owner, () =>
              ctx.client.rpc.call(
                {
                  rpcID: RPC_ID,
                  method: "configure",
                  input: { sessionID: owner.sessionID, ...current.settings, [field]: value },
                  location: ctx.location,
                },
                { signal: owner.controller.signal },
              ),
            );
          } catch (error) {
            assertCurrent(owner);
            await alert(
              owner,
              "Goal settings save failed",
              line(error instanceof Error ? error.message : String(error), 500),
            );
          }
        }
      };
      const execute = async (owner: Flow, shown: GoalSnapshot, action: Action) => {
        if (action === "status") return alert(owner, "Goal status", goalDetails(await get(owner)));
        if (action === "help") return alert(owner, "Goal help", HELP);
        if (action === "settings") return settings(owner);
        if (action === "clear") {
          if (
            !(await wait(owner, () =>
              ctx.ui.dialog.confirm({
                title: "Clear this goal?",
                message: `${clean(shown.goal?.objective ?? "")}\n\nRemove this saved goal and interrupt the current turn. This cannot be undone by the Goal manager.`,
                label: { confirm: "Clear goal", cancel: "Keep goal" },
              }),
            ))
          )
            return;
          if (await unchanged(owner, shown, action)) await command(owner, "clear");
          return;
        }
        if (action === "pause" || action === "resume") {
          if (await unchanged(owner, shown, action)) await command(owner, action);
          return;
        }
        const edit = action === "edit";
        const initial = edit ? clean(shown.goal?.objective ?? "") : undefined;
        const input = await wait(owner, () =>
          ctx.ui.dialog.prompt({
            title: edit ? "Edit goal" : "Start a goal",
            description: edit
              ? "Enter the objective. Prefix --tokens 100k to change the cumulative token budget."
              : "Enter an objective (1–4,000 characters).",
            value: initial,
          }),
        );
        if (input === undefined) return;
        const objective = edit && input === initial ? (shown.goal?.objective ?? input) : input;
        let text = edit ? `edit ${objective}` : objective;
        if (action === "start-budget") {
          const budget = await wait(owner, () =>
            ctx.ui.dialog.prompt({
              title: "Token budget",
              description: "Positive cumulative token ceiling, for example 25k, 100k, or 1m.",
              value: "100k",
            }),
          );
          if (budget === undefined) return;
          const amount = parseTokenBudget(budget);
          if (!amount) return alert(owner, "Invalid token budget", "Enter a positive token count, such as 100k.");
          text = `--tokens ${amount} ${objective}`;
        }
        const parsed = parseGoalCommand(text);
        if (parsed.kind === "error") return alert(owner, "Invalid objective", parsed.message);
        if (parsed.kind !== (edit ? "edit" : "start"))
          return alert(
            owner,
            "Invalid objective",
            "This objective is a Goal command. Enter a descriptive objective instead.",
          );
        if (
          !edit &&
          shown.goal &&
          !(await wait(owner, () =>
            ctx.ui.dialog.confirm({
              title: "Replace saved goal?",
              message: `Replace “${line(shown.goal?.objective ?? "")}” with “${line(parsed.objective)}”? The previous saved goal will be removed.`,
              label: { confirm: "Replace goal", cancel: "Keep goal" },
            }),
          ))
        )
          return;
        if (await unchanged(owner, shown, action)) await command(owner, text);
      };
      const open = async (input?: string) => {
        if (disposed || active) return;
        const sessionID = activeSession(ctx);
        if (!sessionID) {
          await ctx.ui.dialog.alert({ title: "Goal manager", message: "Open a session before managing a goal." });
          return;
        }
        const owner: Flow = { sessionID, controller: new AbortController() };
        active = owner;
        // Navigation has no public event. Only an open flow owns this short-lived
        // watcher, and cancellation aborts pending requests rather than just hiding results.
        const timer = setInterval(() => {
          if (!isCurrent(owner)) owner.controller.abort();
        }, 100);
        try {
          if (input?.trim()) {
            await alert(
              owner,
              "Goal manager",
              "Use /goal-manager without arguments. Use /goal <objective> for direct commands.",
            );
            return;
          }
          while (isCurrent(owner)) {
            const state = await get(owner);
            const view = goalManagerView(state, ctx.data.session.status(sessionID) === "running");
            const action = await wait(owner, () => ctx.ui.dialog.select<Action>(view));
            if (action === undefined) return;
            const option = view.options.find((item) => item.value === action);
            if (!option || option.disabled) continue;
            await execute(owner, state, action);
          }
        } catch (error) {
          if (isCurrent(owner))
            await alert(
              owner,
              "Goal manager unavailable",
              line(error instanceof Error ? error.message : String(error), 500),
            ).catch(() => {});
        } finally {
          clearInterval(timer);
          owner.controller.abort();
          if (active === owner) active = undefined;
        }
      };
      ctx.keymap.layer(() => ({
        // Slash completion temporarily enters autocomplete mode. A global
        // discovery-only layer keeps this command visible without adding a keybind.
        mode: "global",
        commands: [
          {
            id: "romm0109.goal.manager",
            title: "Goal manager",
            description: "Manage the current goal and its safety settings",
            palette: true,
            slash: { name: "goal-manager" },
            run: open,
          },
        ],
      }));
      return () => {
        disposed = true;
        active?.controller.abort();
      };
    },
  };
}
