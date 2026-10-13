import assert from "node:assert/strict";
import test from "node:test";
import { registerGoal } from "../src/goal.ts";
import { registerPlan } from "../src/plan.ts";

const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise(setImmediate);
};
function harness() {
  const queue = [];
  const values = new Map();
  const commands = new Map();
  const tools = new Map();
  const hooks = new Map();
  let wake;
  let seq = 0;
  let idle = Promise.resolve();
  let nativeTokens = 0;
  const calls = { prompt: [], synthetic: [], interrupt: [], wait: [] };
  const ctx = {
    storage: {
      get: async (key) => structuredClone(values.get(key)),
      set: async (key, value) => values.set(key, structuredClone(value)),
      remove: async (key) => values.delete(key),
      scan: async ({ prefix }) => ({
        entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    },
    event: {
      subscribe: async function* ({ signal }) {
        signal.addEventListener("abort", () => wake?.());
        while (!signal.aborted) {
          if (queue.length) yield queue.shift();
          else
            await new Promise((resolve) => {
              wake = resolve;
            });
        }
      },
    },
    session: {
      hook: async (name, handler) => hooks.set(name, handler),
      interrupt: async (input) => calls.interrupt.push(input),
      prompt: async (input) => {
        calls.prompt.push(input);
        await hooks.get("prompt")?.({ ...input, prompt: { text: input.text } });
      },
      synthetic: async (input) => calls.synthetic.push(input),
      wait: async (input) => {
        calls.wait.push(input);
        await idle;
      },
      get: async () => ({
        agent: "build",
        tokens: { input: nativeTokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
      switchAgent: async () => {},
    },
    tool: { transform: async (register) => register({ add: (tool) => tools.set(tool.name, tool) }) },
    command: { transform: async (register) => register({ add: (command) => commands.set(command.name, command) }) },
    permission: { hook: async (name, handler) => hooks.set(`permission:${name}`, handler) },
  };
  const emit = (type, data = {}) => {
    if (type === "session.step.ended")
      nativeTokens +=
        Object.values(data.tokens ?? {})
          .filter((v) => typeof v === "number")
          .reduce((a, b) => a + b, 0) +
        (data.tokens?.cache?.read ?? 0) +
        (data.tokens?.cache?.write ?? 0);
    queue.push({ id: `event-${++seq}`, type, created: Date.now(), data: { sessionID: "s1", ...data } });
    wake?.();
  };
  return {
    ctx,
    values,
    commands,
    tools,
    calls,
    hooks,
    emit,
    goal: () => values.get("workflow/goal/s1"),
    command: (text) => commands.get("goal").execute({ sessionID: "s1", prompt: { text } }),
    context: async () => {
      const event = { sessionID: "s1", options: {}, system: [], messages: [], tools: {} };
      await hooks.get("context")(event);
      return event;
    },
    step: async (id = `assistant-${seq}`) => {
      await hooks.get("context")({ sessionID: "s1", options: {}, system: [], messages: [], tools: {} });
      emit("session.step.started", { assistantMessageID: id, started: Date.now() });
      await flush();
      return id;
    },
    end: (id, text = "progress", input = 4, output = 5, cache = 2) => {
      emit("session.text.ended", { assistantMessageID: id, ordinal: 0, text });
      emit("session.step.ended", {
        assistantMessageID: id,
        finish: "stop",
        tokens: { input, output, reasoning: 1, cache: { read: cache, write: 0 } },
      });
    },
    execution: (messageID) => ({ sessionID: "s1", messageID, signal: new AbortController().signal }),
    holdIdle: () => {
      let release;
      idle = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
    setTokens: (value) => {
      nativeTokens = value;
    },
  };
}

test("informational commands never wake the model; removed queue verbs remain errors", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal status");
  await app.command("/goal add queued work");
  await app.command("/goal clear");
  assert.equal(app.calls.prompt.length, 0);
  assert(app.calls.synthetic.every((call) => call.resume === false));
  close();
});

test("pause/resume preserves objective and lifetime budget but resets the safety epoch", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal feature");
  app.values.set("workflow/goal/s1", { ...app.goal(), automaticTurns: 25, tokensUsed: 12 });
  app.setTokens(42);
  await app.command("/goal pause");
  await app.command("/goal resume");
  assert.equal(app.goal().objective, "feature");
  assert.equal(app.goal().automaticTurns, 0);
  assert.equal(app.goal().tokensUsed, 12);
  await app.context();
  assert.equal(app.goal().baselineTokens, 30);
  close();
});

test("helper tools require response ownership, exact active ID and evidence", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal verify");
  const id = await app.step();
  const complete = app.tools.get("goal_complete");
  await assert.rejects(
    complete.execute({ goal_id: "old", summary: "Done", evidence: ["test"] }, app.execution(id)),
    /exact active goal/,
  );
  await assert.rejects(
    complete.execute({ goal_id: app.goal().id, summary: "incomplete", evidence: ["test"] }, app.execution(id)),
    /verification evidence/,
  );
  await complete.execute(
    { goal_id: app.goal().id, summary: "Verified", evidence: ["npm test passed"] },
    app.execution(id),
  );
  assert.equal(app.goal().status, "complete");
  close();
});

test("primary context caps output while auxiliary generation has no Goal hook", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal --tokens 10 work");
  assert.equal(app.hooks.has("generate"), false);
  const context = await app.context();
  assert.equal(context.options.maxTokens, 10);
  context.options.maxTokens = 3;
  await app.hooks.get("context")(context);
  assert.equal(context.options.maxTokens, 3);
  close();
});

test("committed native usage enforces budgets before subscriber processing", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal --tokens 10 work");
  await app.context();
  app.setTokens(12);
  await app.context();
  assert.equal(app.goal().tokensUsed, 12);
  assert.equal(app.goal().status, "budget_limited");
  assert.equal(app.calls.interrupt.length, 1);
  close();
});

test("step accounting includes cache tokens exactly once with duplicate ends", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal work");
  const id = await app.step();
  app.end(id);
  await flush();
  assert.equal(app.goal().tokensUsed, 12);
  assert.equal(app.goal().automaticTurns, 1);
  app.emit("session.step.ended", {
    assistantMessageID: id,
    finish: "stop",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  await flush();
  assert.equal(app.goal().automaticTurns, 1);
  close();
});

test("automatic continuation waits for settled idle and queues once", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal work");
  const release = app.holdIdle();
  const id = await app.step();
  app.end(id);
  app.emit("session.execution.succeeded");
  await flush();
  assert.equal(app.calls.wait.length, 1);
  assert.equal(app.calls.prompt.length, 1);
  app.emit("session.execution.succeeded");
  release();
  await flush();
  assert.equal(app.calls.prompt.length, 2);
  assert.equal(app.calls.prompt.at(-1).delivery, "queue");
  close();
});

test("new user input cancels old pending continuation without replacing objective", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal work");
  const release = app.holdIdle();
  const id = await app.step();
  app.end(id);
  app.emit("session.execution.succeeded");
  await flush();
  await app.hooks.get("prompt")({ sessionID: "s1", prompt: { text: "new details" } });
  release();
  await flush();
  assert.equal(app.calls.prompt.length, 1);
  assert.equal(app.goal().automaticTurns, 0);
  close();
});

test("clear and replacement prevent old usage and automatic submissions", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal old");
  const release = app.holdIdle();
  const id = await app.step();
  app.end(id);
  app.emit("session.execution.succeeded");
  await flush();
  await app.command("/goal clear");
  await app.command("/goal replacement");
  release();
  await flush();
  assert.equal(app.goal().objective, "replacement");
  assert.equal(app.goal().tokensUsed, 0);
  assert.equal(app.calls.prompt.length, 2);
  close();
});

test("cleanup never waits for native idle and prevents later submissions", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal work");
  const release = app.holdIdle();
  const id = await app.step();
  app.end(id);
  app.emit("session.execution.succeeded");
  await flush();
  close();
  close();
  release();
  await flush();
  assert.equal(app.calls.prompt.length, 1);
});

test("three repeated tool-free outputs pause instead of looping", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal work");
  for (let n = 0; n < 3; n++) {
    const id = await app.step(`a-${n}`);
    app.end(id, "same output");
    app.emit("session.execution.succeeded");
    await flush();
  }
  assert.equal(app.goal().status, "paused");
  assert.equal(app.calls.prompt.length, 3);
  close();
});

test("waiting retains Goal ownership and clamps safety wakes to ten seconds", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await registerPlan(app.ctx);
  await app.command("/goal external");
  // Plan registered a context hook too; restore a standalone Goal harness hook for this direct tool test.
  const separate = harness();
  const cleanup = await registerGoal(separate.ctx);
  await separate.command("/goal external");
  const id = await separate.step();
  await separate.tools
    .get("goal_wait")
    .execute({ goal_id: separate.goal().id, reason: "CI result", resume_after_ms: 1 }, separate.execution(id));
  assert.equal(separate.goal().status, "waiting");
  assert(separate.goal().resumeAt >= Date.now() + 9900);
  app.values.set("workflow/goal/s1", separate.goal());
  await app.commands.get("plan").execute({ sessionID: "s1", prompt: { text: "/plan new task" } });
  assert.match(app.calls.synthetic.at(-1).text, /Goal owns/);
  cleanup();
  close();
});

test("blocked requires three actual Goal responses and fresh evidence", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal work");
  const id = await app.step();
  await assert.rejects(
    app.tools
      .get("goal_blocked")
      .execute(
        { goal_id: app.goal().id, reason: "Permission missing", evidence: ["denied"], repeated_turns: 3 },
        app.execution(id),
      ),
    /three Goal responses/,
  );
  close();
});

test("Plan and Goal concurrent starts are serialized", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await registerPlan(app.ctx);
  await Promise.all([
    app.command("/goal work"),
    app.commands.get("plan").execute({ sessionID: "s1", prompt: { text: "/plan work" } }),
  ]);
  assert.equal(app.goal().status, "active");
  assert.equal(app.values.has("workflow/plan/s1"), false);
  close();
});

test("malformed stored state is protected from ordinary writes", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  app.values.set("workflow/goal/s1", { newerVersion: true });
  await assert.rejects(app.command("/goal work"), /invalid/);
  assert.deepEqual(app.values.get("workflow/goal/s1"), { newerVersion: true });
  close();
});

test("late step from old primary snapshot cannot charge or complete an edited Goal", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal old objective");
  const id = await app.step();
  const oldID = app.goal().id;
  await app.command("/goal edit replacement objective");
  app.end(id);
  await flush();
  assert.equal(app.goal().tokensUsed, 0);
  await assert.rejects(
    app.tools
      .get("goal_complete")
      .execute({ goal_id: oldID, summary: "Verified", evidence: ["old evidence"] }, app.execution(id)),
    /does not own/,
  );
  close();
});

test("genuine tool waits for delayed event subscription ownership", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal work");
  await app.context();
  const result = app.tools
    .get("goal_complete")
    .execute({ goal_id: app.goal().id, summary: "Verified", evidence: ["test"] }, app.execution("delayed"));
  await flush();
  assert.equal(app.goal().status, "active");
  app.emit("session.step.started", { assistantMessageID: "delayed", started: Date.now() });
  await result;
  assert.equal(app.goal().status, "complete");
  close();
});

test("native retry duplicate starts consume one response and no auxiliary tickets", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal work");
  const id = await app.step("retry");
  await app.context();
  app.emit("session.step.started", { assistantMessageID: id, started: Date.now() });
  app.end(id);
  app.emit("session.execution.succeeded");
  await flush();
  assert.equal(app.goal().automaticTurns, 1);
  assert.equal(app.calls.prompt.length, 2);
  close();
});

test("quota and ordinary exhausted failures have distinct states, no synthetic retries", async () => {
  for (const [message, status] of [
    ["insufficient quota credits", "usage_limited"],
    ["Network request failed after native retries", "blocked"],
  ]) {
    const app = harness();
    const close = await registerGoal(app.ctx);
    await app.command("/goal work");
    await app.step();
    app.emit("session.execution.failed", { error: { type: "provider", message } });
    await flush();
    assert.equal(app.goal().status, status);
    assert.equal(app.calls.prompt.length, 1);
    close();
  }
});

test("restored deadline waits until idle, then resumes once", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const app = harness();
  let close = await registerGoal(app.ctx);
  await app.command("/goal external");
  const id = await app.step();
  await app.tools
    .get("goal_wait")
    .execute({ goal_id: app.goal().id, reason: "CI completes", resume_after_ms: 10_000 }, app.execution(id));
  close();
  const release = app.holdIdle();
  close = await registerGoal(app.ctx);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(app.goal().status, "waiting");
  assert.equal(app.calls.prompt.length, 1);
  release();
  await flush();
  assert.equal(app.goal().status, "active");
  assert.equal(app.calls.prompt.length, 2);
  close();
});

test("external input cancels deadline and resumes without an extra automatic wake", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 2_000_000 });
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal external");
  const id = await app.step();
  await app.tools
    .get("goal_wait")
    .execute({ goal_id: app.goal().id, reason: "CI completes", resume_after_ms: 10_000 }, app.execution(id));
  await app.hooks.get("prompt")({ sessionID: "s1", prompt: { text: "CI passed" } });
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(app.goal().status, "active");
  assert.equal(app.calls.prompt.length, 1);
  close();
});

test("failed response usage remains charged across explicit resume", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal work");
  await app.step();
  app.setTokens(17);
  app.emit("session.execution.failed", { error: { type: "provider", message: "Permanent invalid request" } });
  await flush();
  assert.equal(app.goal().tokensUsed, 17);
  await app.command("/goal resume");
  await app.context();
  assert.equal(app.goal().tokensUsed, 17);
  close();
});

test("failed prompt delivery pauses the same Goal rather than claiming active work", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  app.ctx.session.prompt = async () => {
    throw new Error("admission failed");
  };
  await assert.rejects(app.command("/goal work"), /admission failed/);
  assert.equal(app.goal().status, "paused");
  assert.match(app.goal().lastError, /delivery failed/);
  close();
});

test("restored contract stays at its retained-history boundary on later requests", async () => {
  const app = harness();
  const close = await registerGoal(app.ctx);
  await app.command("/goal work");
  const history = { id: "retained", role: "user", content: [{ type: "text", text: "compacted summary" }] };
  const first = { sessionID: "s1", system: [], messages: [history], tools: {}, options: {} };
  await app.hooks.get("context")(first);
  const second = {
    sessionID: "s1",
    system: [],
    messages: [history, { id: "newer", role: "assistant", content: [{ type: "text", text: "new work" }] }],
    tools: {},
    options: {},
  };
  await app.hooks.get("context")(second);
  assert.deepEqual(second.messages.slice(0, 2), first.messages);
  assert.equal(second.system.length, 0);
  close();
});
