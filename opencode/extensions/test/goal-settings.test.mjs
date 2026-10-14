import assert from "node:assert/strict";
import test from "node:test";
import { goalRPC, readGoalSettings, registerGoalSettings } from "../src/goal-settings.ts";
import { workflowTransition } from "../src/workflow-lock.ts";
import {
  goalActiveSeconds,
  recordGoalUsage,
  renderGoalStatus,
  startGoal,
  transitionGoal,
  validGoalState,
} from "../src/workflow-state.ts";

const SETTINGS_KEY = "workflow/goal-settings";
const defaults = { automaticTurns: 25, noProgressTurns: 3 };
const request = (settings = defaults, sessionID = "s1") => ({ sessionID, ...settings });
const execution = (controller = new AbortController()) => ({ signal: controller.signal });
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function harness() {
  const values = new Map();
  const writes = [];
  let handlers;
  let definition;
  const ctx = {
    storage: {
      get: async (key) => structuredClone(values.get(key)),
      set: async (key, value) => {
        writes.push({ key, value: structuredClone(value) });
        values.set(key, structuredClone(value));
      },
      remove: async (key) => {
        writes.push({ key, remove: true });
        values.delete(key);
      },
    },
    rpc: {
      register: async (registeredDefinition, registeredHandlers) => {
        definition = registeredDefinition;
        handlers = registeredHandlers;
        return { dispose: async () => {} };
      },
    },
  };
  const runtime = {
    read: async (sessionID) => {
      const value = await ctx.storage.get(`workflow/goal/${sessionID}`);
      if (value !== undefined && !validGoalState(value)) throw new Error("Goal state is invalid.");
      return value;
    },
    mutate: async (sessionID, update) => {
      const next = update(await runtime.read(sessionID));
      if (next) await ctx.storage.set(`workflow/goal/${sessionID}`, JSON.parse(JSON.stringify(next)));
      else await ctx.storage.remove(`workflow/goal/${sessionID}`);
      return next;
    },
  };
  await registerGoalSettings(ctx, runtime);
  return {
    ctx,
    runtime,
    handlers,
    definition,
    values,
    writes,
    goal: (sessionID = "s1") => values.get(`workflow/goal/${sessionID}`),
    seedGoal: (goal = startGoal("Ship", { id: "goal-1" }), sessionID = "s1") =>
      values.set(`workflow/goal/${sessionID}`, structuredClone(goal)),
  };
}

test("missing settings reads return defaults without creating storage", async () => {
  const app = await harness();
  assert.deepEqual(await readGoalSettings(app.ctx), defaults);
  assert.deepEqual(await app.handlers.get({ sessionID: "s1" }), {
    goal: null,
    settings: defaults,
    elapsedMs: 0,
  });
  assert.equal(app.values.size, 0);
  assert.deepEqual(app.writes, []);
  assert.equal(app.definition, goalRPC);
  assert.equal(goalRPC.id, "romm0109.goal");
  assert.deepEqual(Object.keys(goalRPC.methods), ["get", "configure"]);
  assert.equal(goalRPC.methods.configure.input.additionalProperties, false);
  assert.deepEqual(goalRPC.methods.configure.input.required, ["sessionID", "automaticTurns", "noProgressTurns"]);
});

test("explicit null disables each limit and saves retain unknown settings fields", async () => {
  const app = await harness();
  app.values.set(SETTINGS_KEY, { automaticTurns: null, noProgressTurns: 3, future: { mode: "retain" } });
  assert.deepEqual(await readGoalSettings(app.ctx), { automaticTurns: null, noProgressTurns: 3 });
  const changed = { automaticTurns: 9, noProgressTurns: null };
  assert.deepEqual(await app.handlers.configure(request(changed), execution()), {
    goal: null,
    settings: changed,
    elapsedMs: 0,
  });
  assert.deepEqual(app.values.get(SETTINGS_KEY), { ...changed, future: { mode: "retain" } });
  assert.equal(app.values.has("workflow/goal/s1"), false);
  assert.equal(app.writes.length, 1);
});

test("malformed stored documents block reads and saves without overwriting", async () => {
  for (const invalid of [
    null,
    [],
    "text",
    1,
    true,
    {},
    { automaticTurns: 25 },
    { noProgressTurns: 3 },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "25", false, Number.POSITIVE_INFINITY].flatMap((value) => [
      { ...defaults, automaticTurns: value },
      { ...defaults, noProgressTurns: value },
    ]),
  ]) {
    const app = await harness();
    app.values.set(SETTINGS_KEY, invalid);
    await assert.rejects(readGoalSettings(app.ctx), /settings are invalid/);
    await assert.rejects(app.handlers.get({ sessionID: "s1" }), /settings are invalid/);
    await assert.rejects(app.handlers.configure(request(), execution()), /settings are invalid/);
    assert.deepEqual(app.values.get(SETTINGS_KEY), invalid);
    assert.deepEqual(app.writes, []);
  }
});

test("RPC rejects malformed requests and non-positive or unsafe limits", async () => {
  const app = await harness();
  for (const input of [null, [], {}, { sessionID: " " }, { sessionID: "@goal-settings" }, { sessionID: "s", extra: 1 }])
    await assert.rejects(app.handlers.get(input), /Invalid Goal settings request/);
  for (const input of [
    { sessionID: "s1" },
    { sessionID: "s1", automaticTurns: 3 },
    ...[0, -1, 0.5, "25", false, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].flatMap((limit) => [
      request({ ...defaults, automaticTurns: limit }),
      request({ ...defaults, noProgressTurns: limit }),
    ]),
  ])
    await assert.rejects(app.handlers.configure(input, execution()), /positive safe integers or null/);
  assert.deepEqual(app.writes, []);
  const accepted = { automaticTurns: Number.MAX_SAFE_INTEGER, noProgressTurns: null };
  assert.deepEqual((await app.handlers.configure(request(accepted), execution())).settings, accepted);
});

test("configure updates only the selected Goal and get exposes active elapsed milliseconds", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const app = await harness();
  app.seedGoal();
  app.seedGoal(startGoal("Other", { id: "goal-2" }), "s2");
  t.mock.timers.tick(1250);
  const settings = { automaticTurns: null, noProgressTurns: 8 };
  const result = await app.handlers.configure(request(settings), execution());
  assert.deepEqual(result.settings, settings);
  assert.equal(result.goal.automaticTurnLimit, null);
  assert.equal(result.goal.noProgressTurnLimit, 8);
  assert.equal(result.goal.lifecycle, 0);
  assert.equal(result.elapsedMs, 1250);
  assert.equal(app.goal("s2").automaticTurnLimit, 25);
  assert.equal(app.goal("s2").noProgressTurnLimit, 3);
  assert.deepEqual(await readGoalSettings(app.ctx), settings);
  assert.equal((await app.handlers.get({ sessionID: "s1" })).elapsedMs, 1250);
});

test("Goal defaults initialize the clock and preserve null safety limits", () => {
  const goal = startGoal("Ship", { id: "g", now: 1000 });
  assert.equal(goal.automaticTurnLimit, 25);
  assert.equal(goal.noProgressTurnLimit, 3);
  assert.equal(goal.activeSeconds, 0);
  assert.equal(goal.activeStartedAt, 1000);
  assert.equal(validGoalState(goal), true);
  const unlimited = startGoal("Ship", { now: 1000, automaticTurnLimit: null, noProgressTurnLimit: null });
  assert.equal(unlimited.automaticTurnLimit, null);
  assert.equal(unlimited.noProgressTurnLimit, null);
  assert.equal(recordGoalUsage({ ...unlimited, automaticTurns: 1000 }, 2, 2000).status, "active");
  assert.equal(recordGoalUsage({ ...unlimited, tokenBudget: 2 }, 2, 2000).status, "budget_limited");
  assert.match(renderGoalStatus(unlimited, 2500), /unlimited automatic turns/);
  assert.match(renderGoalStatus(unlimited, 2500), /1s active elapsed/);
});

test("clock checkpoints preserve fractions and exclude every inactive status", () => {
  for (const status of ["paused", "waiting", "blocked", "usage_limited", "budget_limited", "complete"]) {
    const started = startGoal("Ship", { now: 1000 });
    const observed = recordGoalUsage(started, 1, 1750);
    assert.equal(observed.activeSeconds, 0.75);
    assert.equal(observed.activeStartedAt, 1750);
    const stopped = transitionGoal(observed, status, {}, 2250);
    assert.equal(stopped.activeSeconds, 1.25);
    assert.equal(stopped.activeStartedAt, undefined);
    assert.equal(goalActiveSeconds(stopped, 50_000), 1.25);
    const resumed = transitionGoal(stopped, "active", {}, 60_000);
    assert.equal(resumed.activeSeconds, 1.25);
    assert.equal(resumed.activeStartedAt, 60_000);
    assert.equal(goalActiveSeconds(resumed, 61_500), 2.75);
    const checkpoint = transitionGoal(resumed, "active", {}, 62_000);
    assert.equal(goalActiveSeconds(checkpoint, 63_000), 4.25);
    assert.equal(goalActiveSeconds(stopped, 0), 1.25);
  }
});

test("usage checkpoints stop the clock for both safety and budget pauses", () => {
  const goal = startGoal("Ship", { now: 1000, automaticTurnLimit: 1 });
  const paused = recordGoalUsage(goal, 0, 3000);
  assert.equal(paused.status, "paused");
  assert.equal(paused.activeSeconds, 2);
  assert.equal(paused.activeStartedAt, undefined);
  assert.equal(goalActiveSeconds(paused, 100_000), 2);
  const budget = recordGoalUsage({ ...goal, tokenBudget: 1 }, 1, 3500);
  assert.equal(budget.status, "budget_limited");
  assert.equal(budget.activeSeconds, 2.5);
  assert.equal(budget.activeStartedAt, undefined);
  assert.equal(recordGoalUsage(budget, 1, 99_000).activeSeconds, 2.5);
});

test("legacy clocks do not guess a baseline and backward clock changes cannot subtract time", () => {
  const { activeSeconds, activeStartedAt, noProgressTurnLimit, ...legacy } = startGoal("Ship", { now: 1000 });
  assert.equal(validGoalState(legacy), true);
  assert.equal(goalActiveSeconds(legacy, 999_999), 0);
  assert.equal(transitionGoal(legacy, "paused", {}, 999_999).activeSeconds, 0);
  const checkpoint = recordGoalUsage(legacy, 1, 2000);
  assert.equal(checkpoint.activeSeconds, 0);
  assert.equal(goalActiveSeconds(checkpoint, 2500), 0.5);
  const backwards = { ...checkpoint, activeSeconds: 2 };
  assert.equal(goalActiveSeconds(backwards, 500), 2);
  assert.equal(recordGoalUsage(backwards, 0, 500).activeSeconds, 2);
});

test("stored Goal validation checks nullable safety limits and optional clock fields", () => {
  const goal = startGoal("Ship", { now: 1000 });
  for (const field of ["automaticTurnLimit", "noProgressTurnLimit"]) {
    assert.equal(validGoalState({ ...goal, [field]: null }), true);
    for (const value of [0, -1, 1.2, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      assert.equal(validGoalState({ ...goal, [field]: value }), false);
  }
  for (const value of [-1, "1", null, NaN, Infinity])
    assert.equal(validGoalState({ ...goal, activeSeconds: value }), false);
  assert.equal(validGoalState({ ...goal, activeSeconds: 1.25 }), true);
  for (const value of [-1, 1.5, "1", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(validGoalState({ ...goal, activeStartedAt: value }), false);
  assert.equal(validGoalState({ ...goal, activeStartedAt: 0 }), true);
});

test("failed global saves and malformed selected Goals leave both states intact", async () => {
  const app = await harness();
  app.seedGoal();
  app.values.set(SETTINGS_KEY, { ...defaults, future: true });
  const originalGoal = structuredClone(app.goal());
  app.ctx.storage.set = async () => {
    throw new Error("Storage unavailable");
  };
  await assert.rejects(
    app.handlers.configure(request({ automaticTurns: 2, noProgressTurns: 1 }), execution()),
    /Storage unavailable/,
  );
  assert.deepEqual(app.values.get(SETTINGS_KEY), { ...defaults, future: true });
  assert.deepEqual(app.goal(), originalGoal);
  app.seedGoal({ invalid: true });
  await assert.rejects(app.handlers.configure(request(), execution()), /Goal state is invalid/);
  assert.deepEqual(app.writes, []);
});

test("runtime failure restores the exact previous global document or its absence", async () => {
  for (const stored of [undefined, { automaticTurns: null, noProgressTurns: 3, future: { retained: true } }]) {
    const app = await harness();
    app.seedGoal();
    if (stored !== undefined) app.values.set(SETTINGS_KEY, stored);
    app.runtime.mutate = async () => {
      throw new Error("Goal write failed");
    };
    await assert.rejects(app.handlers.configure(request(), execution()), /Goal write failed/);
    assert.deepEqual(app.values.get(SETTINGS_KEY), stored);
    assert.equal(app.values.has(SETTINGS_KEY), stored !== undefined);
    assert.deepEqual(await readGoalSettings(app.ctx), stored ? { automaticTurns: null, noProgressTurns: 3 } : defaults);
  }
});

test("cancellation before saving makes no changes", async () => {
  const app = await harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(app.handlers.configure(request(), execution(controller)), { name: "AbortError" });
  await assert.rejects(app.handlers.get({ sessionID: "s1" }, execution(controller)), { name: "AbortError" });
  assert.deepEqual(app.writes, []);
});

test("cancellation during the global save rolls back before changing the Goal", async () => {
  const app = await harness();
  app.seedGoal();
  const controller = new AbortController();
  const originalSet = app.ctx.storage.set;
  app.ctx.storage.set = async (key, value) => {
    await originalSet(key, value);
    if (key === SETTINGS_KEY) controller.abort();
  };
  await assert.rejects(
    app.handlers.configure(request({ automaticTurns: null, noProgressTurns: null }), execution(controller)),
    { name: "AbortError" },
  );
  assert.equal(app.values.has(SETTINGS_KEY), false);
  assert.equal(app.goal().automaticTurnLimit, 25);
  assert.equal(
    app.writes.some(({ key }) => key === "workflow/goal/s1"),
    false,
  );
});

test("cancellation during the Goal save restores limits without losing later usage", async () => {
  const app = await harness();
  app.seedGoal();
  app.values.set(SETTINGS_KEY, { ...defaults, future: "kept" });
  const controller = new AbortController();
  const originalSet = app.ctx.storage.set;
  app.ctx.storage.set = async (key, value) => {
    await originalSet(key, value);
    if (key === "workflow/goal/s1" && value.automaticTurnLimit === null) {
      app.values.set(key, transitionGoal({ ...app.values.get(key), tokensUsed: 42 }, "paused"));
      controller.abort();
    }
  };
  await assert.rejects(
    app.handlers.configure(request({ automaticTurns: null, noProgressTurns: null }), execution(controller)),
    { name: "AbortError" },
  );
  assert.deepEqual(app.values.get(SETTINGS_KEY), { ...defaults, future: "kept" });
  assert.equal(app.goal().automaticTurnLimit, 25);
  assert.equal(app.goal().noProgressTurnLimit, 3);
  assert.equal(app.goal().tokensUsed, 42);
  assert.equal(app.goal().status, "paused");
  assert.equal(app.goal().lifecycle, 1);
});

test("global readers and other sessions wait until a failed update has rolled back", async () => {
  const app = await harness();
  app.seedGoal();
  app.values.set(SETTINGS_KEY, { ...defaults, future: ["keep"] });
  const entered = deferred();
  const release = deferred();
  const originalMutate = app.runtime.mutate;
  app.runtime.mutate = async (sessionID, update) => {
    if (sessionID === "s1") {
      entered.resolve();
      await release.promise;
      throw new Error("Goal write failed");
    }
    return originalMutate(sessionID, update);
  };
  const first = app.handlers.configure(request({ automaticTurns: null, noProgressTurns: null }), execution());
  const failed = assert.rejects(first, /Goal write failed/);
  await entered.promise;
  const order = [];
  const read = readGoalSettings(app.ctx).then((settings) => {
    order.push("read");
    return settings;
  });
  const get = app.handlers.get({ sessionID: "s2" }).then((result) => {
    order.push("get");
    return result;
  });
  const secondSettings = { automaticTurns: 9, noProgressTurns: 2 };
  const second = app.handlers.configure(request(secondSettings, "s3"), execution()).then((result) => {
    order.push("configure");
    return result;
  });
  await Promise.resolve();
  assert.deepEqual(order, []);
  release.resolve();
  await failed;
  assert.deepEqual(await read, defaults);
  assert.deepEqual((await get).settings, defaults);
  assert.deepEqual((await second).settings, secondSettings);
  assert.deepEqual(order, ["read", "get", "configure"]);
  assert.deepEqual(app.values.get(SETTINGS_KEY), { ...secondSettings, future: ["keep"] });
});

test("RPC lock order cooperates with a command holding the session lock", async () => {
  const app = await harness();
  const entered = deferred();
  const release = deferred();
  const command = workflowTransition(app.ctx.storage, "s1", async () => {
    entered.resolve();
    await release.promise;
    return readGoalSettings(app.ctx);
  });
  await entered.promise;
  const changed = { automaticTurns: null, noProgressTurns: 2 };
  const configure = app.handlers.configure(request(changed), execution());
  release.resolve();
  assert.deepEqual(await command, defaults);
  assert.deepEqual((await configure).settings, changed);
});

test("rollback failure reports both errors and releases the settings queue", async () => {
  const app = await harness();
  app.seedGoal();
  app.values.set(SETTINGS_KEY, defaults);
  app.runtime.mutate = async () => {
    throw new Error("Goal write failed");
  };
  const originalSet = app.ctx.storage.set;
  app.ctx.storage.set = async (key, value) => {
    if (key === SETTINGS_KEY && value.automaticTurns === 25) throw new Error("Rollback failed");
    return originalSet(key, value);
  };
  await assert.rejects(
    app.handlers.configure(request({ automaticTurns: null, noProgressTurns: null }), execution()),
    (error) => {
      assert(error instanceof AggregateError);
      assert.match(error.message, /rollback failed/);
      assert.deepEqual(
        error.errors.map((entry) => entry.message),
        ["Goal write failed", "Rollback failed"],
      );
      return true;
    },
  );
  assert.deepEqual(await readGoalSettings(app.ctx), { automaticTurns: null, noProgressTurns: null });
});
