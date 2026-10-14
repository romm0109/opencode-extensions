import assert from "node:assert/strict";
import test from "node:test";
import { createGoalTui, goalDetails, goalManagerView, parseGoalLimit } from "../src/goal-tui.ts";
import { parseGoalCommand, startGoal, transitionGoal } from "../src/workflow-state.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  let sessionID = "ses-one";
  let running = false;
  let layer;
  let current = {
    goal: null,
    settings: { automaticTurns: 25, noProgressTurns: 3 },
    elapsedMs: 61_000,
    ...options.state,
  };
  const selects = [...(options.selects ?? [])];
  const prompts = [...(options.prompts ?? [])];
  const confirms = [...(options.confirms ?? [])];
  const calls = [];
  const dialogs = [];
  const alerts = [];
  const commands = [];
  const cleared = [];
  const choose = (queue, input) => {
    const value = queue.shift();
    return typeof value === "function" ? value(input) : value;
  };
  const context = {
    location: { directory: "/workspace/project" },
    keymap: {
      layer: (factory) => {
        layer = factory;
      },
    },
    data: { session: { status: () => (running ? "running" : "idle") } },
    ui: {
      router: { current: () => (sessionID ? { type: "session", sessionID } : { type: "home" }) },
      tabs: { list: () => [] },
      dialog: {
        select: async (input) => {
          dialogs.push({ type: "select", ...input });
          return choose(selects, input);
        },
        prompt: async (input) => {
          dialogs.push({ type: "prompt", ...input });
          return choose(prompts, input);
        },
        confirm: async (input) => {
          dialogs.push({ type: "confirm", ...input });
          return choose(confirms, input);
        },
        alert: async (input) => {
          alerts.push(input);
        },
        clear: () => cleared.push(true),
      },
    },
    client: {
      rpc: {
        call: async (input, request) => {
          calls.push({ ...input, signal: request.signal });
          if (options.rpc) {
            const result = await options.rpc(input, request);
            if (result !== undefined) return result;
          }
          if (input.method === "configure")
            current.settings = {
              automaticTurns: input.input.automaticTurns,
              noProgressTurns: input.input.noProgressTurns,
            };
          return { output: structuredClone(current) };
        },
      },
      session: {
        command: async (input, request) => {
          commands.push({ ...input, signal: request.signal });
          if (options.command) return options.command(input, request);
          const parsed = parseGoalCommand(input.text);
          if (parsed.kind === "start") current.goal = startGoal(parsed.objective, { tokenBudget: parsed.tokenBudget });
          if (parsed.kind === "clear") current.goal = null;
          if (parsed.kind === "pause") current.goal = transitionGoal(current.goal, "paused");
          if (parsed.kind === "resume") current.goal = transitionGoal(current.goal, "active");
          if (parsed.kind === "edit")
            current.goal = {
              ...current.goal,
              objective: parsed.objective,
              tokenBudget: parsed.tokenBudget ?? current.goal.tokenBudget,
              lifecycle: current.goal.lifecycle + 1,
            };
        },
      },
    },
  };
  const dispose = createGoalTui().setup(context);
  return {
    context,
    calls,
    dialogs,
    alerts,
    commands,
    cleared,
    dispose,
    run: (input) => layer().commands[0].run(input),
    layer: () => layer(),
    state: () => current,
    setState: (next) => {
      current = next;
    },
    setSession: (next) => {
      sessionID = next;
    },
    setRunning: (next) => {
      running = next;
    },
  };
}

function state(status = "active", overrides = {}) {
  return {
    goal: { ...startGoal("Verify the release", { id: "goal-one", now: 100 }), status },
    settings: { automaticTurns: 25, noProgressTurns: 3 },
    elapsedMs: 61_000,
    ...overrides,
  };
}

function enabled(view, action) {
  return !view.options.find((option) => option.value === action).disabled;
}

test("native manager registers without shadowing server /goal or starting work", () => {
  const h = harness();
  assert.equal(h.layer().mode, "global");
  assert.equal(h.layer().commands[0].slash.name, "goal-manager");
  assert.equal(h.layer().commands[0].palette, true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.dialogs.length, 0);
  h.dispose();
  h.dispose();
});

test("manager labels objective, elapsed time, status, settings and state-dependent actions", () => {
  for (const status of ["active", "waiting", "paused", "blocked", "usage_limited", "budget_limited", "complete"]) {
    const value = state(status);
    const view = goalManagerView(value, false);
    assert.match(view.title, /Verify the release/u);
    assert.match(view.title, /1m 1s active/u);
    assert.equal(enabled(view, "pause"), ["active", "waiting"].includes(status));
    assert.equal(enabled(view, "resume"), !["active", "complete"].includes(status));
    assert.equal(enabled(view, "start"), !["active", "waiting"].includes(status));
    for (const action of ["status", "settings", "help", "clear", "edit"]) assert.equal(enabled(view, action), true);
  }
  const exhausted = state("budget_limited");
  exhausted.goal.tokenBudget = 10;
  exhausted.goal.tokensUsed = 10;
  assert.equal(enabled(goalManagerView(exhausted, false), "resume"), false);
  const empty = goalManagerView(state("active", { goal: null }), false);
  assert.equal(enabled(empty, "edit"), false);
  assert.equal(enabled(empty, "clear"), false);
});

test("busy sessions allow interruption and read-only actions but not start/edit/resume", () => {
  const view = goalManagerView(state(), true);
  assert.match(view.title, /session busy/u);
  for (const action of ["start", "start-budget", "edit", "resume"]) assert.equal(enabled(view, action), false);
  for (const action of ["pause", "clear", "status", "settings", "help"]) assert.equal(enabled(view, action), true);
});

test("display strips terminal controls without modifying persisted objectives", () => {
  const value = state();
  value.goal.objective = "\x1b]0;evil\x07\x1b[31mRelease\x1b[0m\r\ncheck";
  value.goal.waitingFor = "\x1b[31mexternal reply\x1b[0m";
  value.goal.summary = "\x1b[31mdone\x1b[0m";
  value.goal.evidence = ["\x1b[31mtests passed\x1b[0m"];
  value.goal.lastError = "\x1b[31mretry\x1b[0m";
  value.goal.automaticTurnLimit = null;
  value.goal.noProgressTurnLimit = null;
  value.settings.automaticTurns = null;
  value.settings.noProgressTurns = null;
  const before = structuredClone(value);
  const view = goalManagerView(value, false);
  const details = goalDetails(value);
  assert.doesNotMatch(JSON.stringify(view), /evil|\\u001b|\\u0007/u);
  assert.equal(
    details.includes("evil") || details.includes(String.fromCharCode(27)) || details.includes(String.fromCharCode(7)),
    false,
  );
  assert.match(details, /Unlimited/u);
  assert.match(details, /Off/u);
  assert.deepEqual(value, before);
});

test("native start and budget flows dispatch exact session command then reread server state", async () => {
  for (const [action, prompts, expected] of [
    ["start", ["Implement the change"], "Implement the change"],
    ["start-budget", ["Implement the change", "1.5m"], "--tokens 1500000 Implement the change"],
  ]) {
    const h = harness({ selects: [action], prompts });
    await h.run();
    assert.equal(h.commands.length, 1);
    assert.equal(h.commands[0].sessionID, "ses-one");
    assert.equal(h.commands[0].name, "goal");
    assert.equal(h.commands[0].text, expected);
    assert.ok(h.calls.length >= 3);
    assert.ok(
      h.calls.every((call) => call.rpcID === "romm0109.goal" && call.location.directory === "/workspace/project"),
    );
    assert.match(h.dialogs.at(-1).title, /active/u);
    h.dispose();
  }
});

test("start never interprets reserved verbs as lifecycle commands", async () => {
  for (const objective of ["pause", "clear", "status", "", "--tokens 0 invalid", "x".repeat(4001)]) {
    const h = harness({ selects: ["start"], prompts: [objective] });
    await h.run();
    assert.equal(h.commands.length, 0);
    assert.match(h.alerts[0].title, /Invalid objective/u);
    h.dispose();
  }
});

test("edit can update objective and token budget; paused replacement asks for confirmation", async () => {
  const h = harness({ state: state("paused"), selects: ["edit"], prompts: ["--tokens 100k Verify and ship"] });
  await h.run();
  assert.equal(h.commands[0].text, "edit --tokens 100k Verify and ship");
  assert.equal(h.state().goal.tokenBudget, 100_000);
  assert.equal(h.dialogs[1].value, "Verify the release");
  h.dispose();
  const replacement = harness({ state: state("paused"), selects: ["start"], prompts: ["New goal"], confirms: [false] });
  await replacement.run();
  assert.equal(replacement.commands.length, 0);
  assert.match(
    replacement.dialogs.find((dialog) => dialog.type === "confirm").message,
    /Verify the release.*New goal/u,
  );
  replacement.dispose();
});

test("pause while busy and resume while idle keep native command semantics", async () => {
  for (const [status, action, busy] of [
    ["active", "pause", true],
    ["waiting", "resume", false],
    ["paused", "resume", false],
  ]) {
    const h = harness({ state: state(status), selects: [action] });
    h.setRunning(busy);
    await h.run();
    assert.equal(h.commands[0].text, action);
    h.dispose();
  }
});

test("clear requires affirmative native confirmation and identifies the exact objective", async () => {
  for (const answer of [undefined, false, true]) {
    const h = harness({ state: state(), selects: ["clear"], confirms: [answer] });
    await h.run();
    assert.equal(h.commands.length, answer === true ? 1 : 0);
    assert.match(h.dialogs.find((dialog) => dialog.type === "confirm").message, /Verify the release/u);
    if (answer) assert.equal(h.commands[0].text, "clear");
    h.dispose();
  }
});

test("cancelling main, objective, or token prompt causes no mutation", async () => {
  for (const fixture of [{}, { selects: ["start"] }, { selects: ["start-budget"], prompts: ["Release"] }]) {
    const h = harness(fixture);
    await h.run();
    assert.equal(h.commands.length, 0);
    assert.equal(h.calls.filter((call) => call.method === "configure").length, 0);
    h.dispose();
  }
});

test("goal replacement during clear confirmation rejects the stale action", async () => {
  let h;
  h = harness({
    state: state(),
    selects: ["clear"],
    confirms: [
      () => {
        const next = state();
        next.goal.id = "replacement";
        h.setState(next);
        return true;
      },
    ],
  });
  await h.run();
  assert.equal(h.commands.length, 0);
  assert.equal(h.alerts[0].title, "Goal changed");
  h.dispose();
});

test("becoming busy during objective entry rejects start before dispatch", async () => {
  let h;
  h = harness({
    selects: ["start"],
    prompts: [
      () => {
        h.setRunning(true);
        return "Release";
      },
    ],
  });
  await h.run();
  assert.equal(h.commands.length, 0);
  assert.equal(h.alerts[0].title, "Action unavailable");
  h.dispose();
});

test("session switch during native dialog invalidates its answer", async () => {
  let h;
  h = harness({
    selects: ["start"],
    prompts: [
      () => {
        h.setSession("ses-two");
        return "Release";
      },
    ],
  });
  await h.run();
  assert.equal(h.commands.length, 0);
  assert.equal(h.alerts.length, 0);
  assert.ok(h.calls[0].signal.aborted);
  assert.equal(h.cleared.length, 0);
  h.dispose();
});

test("disposal aborts a pending RPC and settles the flow without clearing unrelated dialogs", async () => {
  const entered = deferred();
  const pending = deferred();
  const h = harness({
    rpc: (_input, request) => {
      entered.resolve(request.signal);
      return pending.promise;
    },
  });
  const running = h.run();
  const signal = await entered.promise;
  h.dispose();
  await running;
  assert.equal(signal.aborted, true);
  assert.equal(h.dialogs.length, 0);
  assert.equal(h.alerts.length, 0);
  assert.equal(h.cleared.length, 0);
  pending.resolve({ output: state() });
  await h.run();
  assert.equal(h.calls.length, 1);
});

test("navigation watcher aborts pending transport even before it responds", async () => {
  const entered = deferred();
  const pending = deferred();
  const h = harness({
    rpc: () => {
      entered.resolve();
      return pending.promise;
    },
  });
  const running = h.run();
  await entered.promise;
  h.setSession("ses-two");
  await running;
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.dialogs.length, 0);
  pending.resolve({ output: state() });
  h.dispose();
});

test("repeated manager invocation is ignored until the owning dialog finishes", async () => {
  const entered = deferred();
  const choice = deferred();
  const h = harness({
    selects: [
      () => {
        entered.resolve();
        return choice.promise;
      },
    ],
  });
  const first = h.run();
  await entered.promise;
  await h.run();
  assert.equal(h.calls.length, 1);
  choice.resolve(undefined);
  await first;
  await h.run();
  assert.equal(h.calls.length, 2);
  h.dispose();
});

test("whole-number settings reject malformed, zero, negative and unsafe inputs", () => {
  for (const input of ["", "0", "-1", "1.5", "1e2", "Infinity", "off", "9007199254740992"])
    assert.equal(parseGoalLimit(input), undefined);
  assert.equal(parseGoalLimit(" 42 "), 42);
  assert.equal(parseGoalLimit("9007199254740991"), Number.MAX_SAFE_INTEGER);
});

test("settings persist immediately, retain selected row and read actual saved values", async () => {
  const h = harness({ selects: ["settings", "automaticTurns", "custom"], prompts: ["50"] });
  await h.run();
  const configure = h.calls.find((call) => call.method === "configure");
  assert.deepEqual(configure.input, { sessionID: "ses-one", automaticTurns: 50, noProgressTurns: 3 });
  assert.equal(h.state().settings.automaticTurns, 50);
  const settingsDialogs = h.dialogs.filter((dialog) => dialog.title.startsWith("Goal plugin settings"));
  assert.equal(settingsDialogs[1].current, "automaticTurns");
  assert.match(settingsDialogs[1].options[0].description, /50 responses/u);
  h.dispose();
});

test("Unlimited and Off require confirmation, with cancellation leaving settings unchanged", async () => {
  for (const field of ["automaticTurns", "noProgressTurns"]) {
    for (const confirmation of [true, false, undefined]) {
      const h = harness({ selects: ["settings", field, "off"], confirms: [confirmation] });
      await h.run();
      const writes = h.calls.filter((call) => call.method === "configure");
      assert.equal(writes.length, confirmation === true ? 1 : 0);
      if (confirmation) assert.equal(writes[0].input[field], null);
      assert.match(h.dialogs.find((dialog) => dialog.type === "confirm").message, /consume more tokens/u);
      h.dispose();
    }
  }
});

test("invalid custom setting and cancelled nested choice never write", async () => {
  for (const fixture of [
    { selects: ["settings", "automaticTurns", "custom"], prompts: ["0"] },
    { selects: ["settings", "automaticTurns", "custom"] },
    { selects: ["settings", "automaticTurns"] },
  ]) {
    const h = harness(fixture);
    await h.run();
    assert.equal(h.calls.filter((call) => call.method === "configure").length, 0);
    h.dispose();
  }
});

test("settings save failure rereads prior values and allows another save", async () => {
  let fail = true;
  const h = harness({
    selects: ["settings", "automaticTurns", "custom", "automaticTurns", "custom"],
    prompts: ["50", "75"],
    rpc: (input) => {
      if (input.method === "configure" && fail) {
        fail = false;
        throw new Error("storage unavailable");
      }
    },
  });
  await h.run();
  assert.equal(h.calls.filter((call) => call.method === "configure").length, 2);
  assert.equal(h.state().settings.automaticTurns, 75);
  const settingsDialogs = h.dialogs.filter((dialog) => dialog.title.startsWith("Goal plugin settings"));
  assert.match(settingsDialogs[1].options[0].description, /25 responses/u);
  assert.match(settingsDialogs[2].options[0].description, /75 responses/u);
  assert.equal(h.alerts[0].title, "Goal settings save failed");
  h.dispose();
});

test("settings preserve unrelated concurrent edits but reject changes to edited field", async () => {
  for (const field of ["noProgressTurns", "automaticTurns"]) {
    let h;
    h = harness({
      selects: ["settings", "automaticTurns", "custom"],
      prompts: [
        () => {
          h.state().settings[field] = 8;
          return "50";
        },
      ],
    });
    await h.run();
    const writes = h.calls.filter((call) => call.method === "configure");
    if (field === "automaticTurns") {
      assert.equal(writes.length, 0);
      assert.equal(h.alerts[0].title, "Settings changed");
    } else assert.equal(writes[0].input.noProgressTurns, 8);
    h.dispose();
  }
});

test("a reached limit discloses immediate pause and respects cancellation", async () => {
  const value = state();
  value.goal.automaticTurns = 10;
  for (const answer of [true, false]) {
    const h = harness({
      state: value,
      selects: ["settings", "automaticTurns", "custom"],
      prompts: ["5"],
      confirms: [answer],
    });
    await h.run();
    assert.match(h.dialogs.find((dialog) => dialog.type === "confirm").message, /may pause work immediately/u);
    assert.equal(h.calls.filter((call) => call.method === "configure").length, answer ? 1 : 0);
    h.dispose();
  }
});

test("status and help are local native dialogs without transcript mutations", async () => {
  for (const action of ["status", "help"]) {
    const h = harness({ state: state(), selects: [action] });
    await h.run();
    assert.equal(h.commands.length, 0);
    assert.ok(h.alerts[0].message.length > 100);
    assert.equal(h.calls.filter((call) => call.method === "configure").length, 0);
    h.dispose();
  }
});

test("malformed server state and transport errors remain visible and never enable actions", async () => {
  for (const output of [
    {},
    { ...state(), settings: { automaticTurns: 0, noProgressTurns: 3 } },
    { ...state(), elapsedMs: -1 },
  ]) {
    const h = harness({ rpc: () => ({ output }) });
    await h.run();
    assert.equal(h.dialogs.length, 0);
    assert.equal(h.alerts[0].title, "Goal manager unavailable");
    h.dispose();
  }
  const h = harness({
    rpc: () => {
      throw new Error("\x1b[31mserver offline\x1b[0m");
    },
  });
  await h.run();
  assert.equal(h.alerts[0].message, "server offline");
  h.dispose();
});

test("arguments are rejected and missing session is explained without a server call", async () => {
  const h = harness();
  await h.run("unexpected");
  assert.match(h.alerts[0].message, /without arguments/u);
  assert.equal(h.calls.length, 0);
  h.setSession(undefined);
  await h.run();
  assert.match(h.alerts[1].message, /Open a session/u);
  assert.equal(h.calls.length, 0);
  h.dispose();
});

test("status displays existing goal caps separately from changed plugin defaults", () => {
  const value = state();
  value.goal.automaticTurnLimit = 10;
  value.goal.noProgressTurnLimit = null;
  const details = goalDetails(value);
  assert.match(details, /Automatic work: 0 \/ 10 responses/u);
  assert.match(details, /No-progress guard: 0 \/ Off/u);
  const menu = goalManagerView(value, false);
  assert.match(menu.options.find((option) => option.value === "settings").description, /25 responses/u);
  assert.match(menu.options.find((option) => option.value === "settings").description, /3 responses/u);
});
