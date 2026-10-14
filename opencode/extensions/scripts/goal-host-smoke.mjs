// Native OpenCode lifecycle smoke with a loopback scripted provider. No paid model calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCode } from "@opencode/client";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.argv[2] ?? join(packageRoot, "node_modules/@opencode/cli-linux-x64/bin/opencode");
await access(binary);
const root = await mkdtemp("/tmp/opencode-goal-host-");
const plugin = join(root, "plugin");
const project = join(root, "project");
await mkdir(join(plugin, "src"), { recursive: true });
await mkdir(project, { recursive: true });
await symlink(join(packageRoot, "node_modules"), join(plugin, "node_modules"));
const hashes = {};
for (const name of [
  "goal.ts",
  "goal-runtime.ts",
  "goal-settings.ts",
  "workflow-state.ts",
  "workflow-lock.ts",
  "plan.ts",
  "plugin-types.ts",
]) {
  const source = join(packageRoot, "src", name);
  const bytes = await readFile(source);
  hashes[name] = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(plugin, "src", name), bytes);
}
await writeFile(
  join(plugin, "package.json"),
  JSON.stringify({ name: "goal-native-fixture", type: "module", main: "index.ts" }),
);
await writeFile(
  join(plugin, "index.ts"),
  `
import { Plugin } from "@opencode/plugin";
import { registerGoal } from "./src/goal.ts";
import { registerPlan } from "./src/plan.ts";
const object = { type: "object", additionalProperties: true };
export default Plugin.define({ id: "goal-native-fixture", async setup(ctx) {
  const close = await registerGoal(ctx);
  await registerPlan(ctx);
  await ctx.rpc.register({ id: "goal-native-fixture", methods: { state: { input: object, output: object } }, events: {} }, {
    state: async (input) => ({ goal: (await ctx.storage.get("workflow/goal/" + input.sessionID)) ?? null, plan: (await ctx.storage.get("workflow/plan/" + input.sessionID)) ?? null }),
  });
  return close;
} });
`,
);

const requests = [];
const results = [];
const providerErrors = [];
const counts = new Map();
const hung = new Map();
const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
const record = (name, data) => {
  results.push({ name, data });
  console.log(name, JSON.stringify(data));
};
const pause = (ms = 50) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
const provider = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    const prompt = input.messages
      .filter((message) => message.role === "user")
      .map((message) => textOf(message.content))
      .join("\n");
    const scenario = /scenario:([a-z-]+)/.exec(prompt)?.[1];
    assert(scenario, "Unexpected provider request without a fixture scenario");
    const number = (counts.get(scenario) ?? 0) + 1;
    counts.set(scenario, number);
    assert(number <= 35, `Fixture runaway: ${scenario}`);
    requests.push({ scenario, number, receivedAt: Date.now(), input });
    if (scenario === "retry" && number === 1) {
      response.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
      response.end(
        JSON.stringify({ error: { message: "Scripted temporary service unavailable", type: "server_error" } }),
      );
      return;
    }
    if (scenario === "pause" || scenario === "clear") {
      hung.set(scenario, { started: true, closed: false });
      response.once("close", () => {
        hung.get(scenario).closed = true;
      });
      return;
    }
    let call;
    if (["complete", "deadline", "external-wake", "retry"].includes(scenario) && number === 2) {
      const goalID = [...prompt.matchAll(/Goal ID: ([A-Za-z0-9-]+)/g)].at(-1)?.[1];
      assert(goalID, "Goal ID missing from native primary prompt");
      call = {
        name: "goal_complete",
        arguments: JSON.stringify({
          goal_id: goalID,
          summary: "All scripted requirements verified.",
          evidence: ["Native second request proved automatic continuation."],
        }),
      };
    }
    if (["deadline", "external-wake"].includes(scenario) && number === 1) {
      const goalID = [...prompt.matchAll(/Goal ID: ([A-Za-z0-9-]+)/g)].at(-1)?.[1];
      assert(goalID, "Goal ID missing from native wait prompt");
      call = {
        name: "goal_wait",
        arguments: JSON.stringify({
          goal_id: goalID,
          reason: "Await the local fixture deadline.",
          resume_after_ms: 10,
        }),
      };
    }
    const content =
      scenario === "no-progress"
        ? "Still reviewing the same unchanged fixture."
        : scenario === "complete" && number === 1
          ? "The first fixture requirement is verified. More work remains."
          : "Scripted final response.";
    const delta = call
      ? { tool_calls: [{ index: 0, id: `call-${number}`, type: "function", function: call }] }
      : { content };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [
      {
        id: "script",
        object: "chat.completion.chunk",
        created: 0,
        model: "script",
        choices: [{ index: 0, delta, finish_reason: null }],
      },
      {
        id: "script",
        object: "chat.completion.chunk",
        created: 0,
        model: "script",
        choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
        usage: {
          prompt_tokens: scenario === "budget" ? 4 : 1,
          completion_tokens: scenario === "budget" ? 4 : 1,
          total_tokens: scenario === "budget" ? 8 : 2,
        },
      },
    ])
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  } catch (error) {
    providerErrors.push(String(error));
    response.writeHead(500);
    response.end(String(error));
  }
});
await new Promise((resolveListen) => provider.listen(0, "127.0.0.1", resolveListen));
const providerURL = `http://127.0.0.1:${provider.address().port}/v1`;
await writeFile(
  join(project, "opencode.json"),
  JSON.stringify({
    plugins: [plugin],
    model: "local-script/script",
    warming: false,
    providers: {
      "local-script": {
        name: "Local Script",
        package: "@ai-sdk/openai-compatible",
        settings: { baseURL: providerURL },
        models: { script: { name: "Script", limit: { context: 128000, output: 2000 }, capabilities: { tools: true } } },
      },
    },
  }),
);
const env = {
  PATH: process.env.PATH,
  HOME: join(root, "home"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"),
};
const host = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
  cwd: root,
  env,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let client;
for (const stream of [host.stdout, host.stderr])
  stream.on("data", (chunk) => {
    output += chunk.toString();
  });
const hostError = new Promise((_, reject) => host.once("error", reject));
const until = async (read, predicate, description, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  let latest;
  do {
    latest = await read();
    if (predicate(latest)) return latest;
    await pause();
  } while (Date.now() < deadline);
  throw new Error(`${description}: ${JSON.stringify(latest)}`);
};
const ownedKill = (signal) => {
  try {
    process.kill(-host.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
try {
  await Promise.race([
    hostError,
    until(
      async () => ({
        ready: /server password (\S+)/.test(output) && /server listening on (\S+)/.test(output),
        output: output.replace(/server password \S+/g, "server password [redacted]"),
      }),
      (value) => value.ready,
      "Native host startup",
      30000,
    ),
  ]);
  const baseUrl = /server listening on (\S+)/.exec(output)[1];
  const password = /server password (\S+)/.exec(output)[1];
  client = OpenCode.make({
    baseUrl,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  });
  const info = await client.server.info();
  assert.equal(info.version, "2.0.28");
  record("native-version", info.version);
  const plugins = await until(
    async () =>
      (await client.plugin.list({ location: { directory: project } })).data.filter(
        (item) => item.source?.type !== "builtin",
      ),
    (items) => items.some((item) => item.id === "goal-native-fixture" && item.state.status === "active"),
    "Goal fixture plugin activation",
  );
  record(
    "plugin-active",
    plugins.map((item) => ({ id: item.id, state: item.state.status })),
  );
  const state = async (sessionID) => {
    const reply = await client.rpc.call(
      { rpcID: "goal-native-fixture", method: "state", location: { directory: project }, input: { sessionID } },
      { signal: AbortSignal.timeout(5000) },
    );
    assert(!reply.error, JSON.stringify(reply.error));
    return reply.output;
  };
  const command = (sessionID, text) =>
    client.session.command({ sessionID, name: "goal", text }, { signal: AbortSignal.timeout(10000) });
  const create = (scenario) =>
    client.session.create({
      title: `Goal fixture ${scenario}`,
      location: { directory: project },
      model: { providerID: "local-script", id: "script" },
    });
  const wait = (sessionID) => client.session.wait({ sessionID }, { signal: AbortSignal.timeout(10000) });
  const run = async (name, test) => {
    try {
      await test();
    } catch (error) {
      record(`${name}-failed`, String(error));
    }
  };
  record("source-hashes", hashes);
  await run("automatic-completion", async () => {
    const session = await create("complete");
    await command(session.id, "/goal scenario:complete verify both fixture requirements");
    const current = await until(
      () => state(session.id),
      (value) => value.goal?.status === "complete",
      "Goal did not complete",
    );
    await wait(session.id);
    const observed = requests.filter((item) => item.scenario === "complete");
    assert(observed.length >= 2);
    assert(
      observed[1].input.messages.some((message) =>
        textOf(message.content).includes("Continue the incomplete managed goal"),
      ),
    );
    assert(current.goal.evidence.length > 0);
    record("automatic-completion", {
      status: current.goal.status,
      requests: observed.length,
      verifiedContinuation: true,
    });
  });
  await run("primary-budget", async () => {
    const session = await create("budget");
    await command(session.id, "/goal --tokens 6 scenario:budget exhaust one response");
    const current = await until(
      () => state(session.id),
      (value) => value.goal?.status === "budget_limited",
      "Budget did not stop Goal",
    );
    await wait(session.id);
    const observed = requests.filter((item) => item.scenario === "budget");
    const cap = observed[0].input.max_tokens ?? observed[0].input.max_completion_tokens;
    assert(cap > 0 && cap <= 6, `Primary output was not capped: ${cap}`);
    assert(current.goal.tokensUsed >= 6);
    record("primary-budget", {
      cap,
      tokens: current.goal.tokensUsed,
      status: current.goal.status,
      requests: observed.length,
    });
  });
  await run("no-progress", async () => {
    const session = await create("no-progress");
    await command(session.id, "/goal scenario:no-progress repeat unchanged fixture");
    const current = await until(
      () => state(session.id),
      (value) => value.goal?.status === "paused",
      "Repeated output did not pause Goal",
    );
    await wait(session.id);
    assert.equal(current.goal.noProgressTurns, 3);
    assert.equal(requests.filter((item) => item.scenario === "no-progress").length, 3);
    record("no-progress", {
      status: current.goal.status,
      repeated: current.goal.noProgressTurns,
      requests: counts.get("no-progress"),
    });
  });
  for (const scenario of ["pause", "clear"])
    await run(scenario, async () => {
      const session = await create(scenario);
      await command(session.id, `/goal scenario:${scenario} wait on an unfinished local provider response`);
      await until(
        async () => hung.get(scenario),
        (value) => value?.started,
        "Provider never started",
      );
      await command(session.id, `/goal ${scenario}`);
      await wait(session.id);
      const current = await state(session.id);
      if (scenario === "clear") assert.equal(current.goal, null);
      else assert.equal(current.goal.status, "paused");
      await until(
        async () => hung.get(scenario),
        (value) => value?.closed,
        "Provider connection was not cancelled",
      );
      assert.equal(counts.get(scenario), 1);
      record(scenario, { goal: current.goal?.status ?? null, providerCancelled: true, requests: counts.get(scenario) });
    });
  let externalWakeDeadline;
  await run("external-wake", async () => {
    const session = await create("external-wake");
    await command(session.id, "/goal scenario:external-wake await the fixture event");
    const waiting = await until(
      () => state(session.id),
      (value) => value.goal?.status === "waiting",
      "Goal never entered external wait",
    );
    externalWakeDeadline = waiting.goal.resumeAt;
    await wait(session.id);
    assert.equal(counts.get("external-wake"), 1);
    await client.session.command({ sessionID: session.id, name: "plan", text: "/plan conflicting fixture plan" });
    const guarded = await state(session.id);
    assert.equal(guarded.plan, null, "Plan acquired a waiting Goal's workflow");
    assert.equal(guarded.goal.status, "waiting");
    assert.equal(counts.get("external-wake"), 1, "Rejected Plan command resumed the model");
    record("waiting-goal-mutex", { planDenied: true, noProviderRequest: true });
    await client.session.prompt({
      sessionID: session.id,
      text: "The external fixture event is ready. Continue this Goal now.",
    });
    const completed = await until(
      () => state(session.id),
      (value) => value.goal?.status === "complete",
      "External input did not wake Goal",
    );
    await wait(session.id);
    const observed = requests.filter((item) => item.scenario === "external-wake");
    assert.equal(observed.length, 2);
    assert(observed[1].receivedAt < externalWakeDeadline);
    assert.equal(completed.goal.id, waiting.goal.id);
    record("external-wake", { status: completed.goal.status, requests: observed.length, resumedBeforeDeadline: true });
  });
  await run("native-retry", async () => {
    const session = await create("retry");
    await command(session.id, "/goal scenario:retry recover from one native provider 503");
    const completed = await until(
      () => state(session.id),
      (value) => value.goal?.status === "complete",
      "Native retry did not complete Goal",
    );
    await wait(session.id);
    const observed = requests.filter((item) => item.scenario === "retry");
    assert.equal(observed.length, 2);
    assert.equal(
      completed.goal.continuationCount ?? 0,
      0,
      "Goal injected a synthetic retry instead of letting the host retry",
    );
    assert.deepEqual(observed[1].input.messages, observed[0].input.messages);
    record("native-retry", {
      status: completed.goal.status,
      requests: observed.length,
      provider503Recovered: true,
      syntheticContinuations: 0,
    });
  });
  await run("wait-deadline", async () => {
    const session = await create("deadline");
    await command(session.id, "/goal scenario:deadline wait for the bounded fixture wake");
    const waiting = await until(
      () => state(session.id),
      (value) => value.goal?.status === "waiting",
      "Goal never entered external wait",
    );
    await wait(session.id);
    assert.equal(counts.get("deadline"), 1, "Waiting Goal continued before its safety deadline");
    assert(waiting.goal.resumeAt >= requests.find((item) => item.scenario === "deadline").receivedAt + 10000);
    const completed = await until(
      () => state(session.id),
      (value) => value.goal?.status === "complete",
      "Deadline did not resume and complete Goal",
    );
    await wait(session.id);
    const observed = requests.filter((item) => item.scenario === "deadline");
    assert.equal(observed.length, 2);
    assert(observed[1].receivedAt >= waiting.goal.resumeAt);
    assert(
      observed[1].input.messages.some((message) => textOf(message.content).includes("external-wait deadline is due")),
    );
    record("wait-deadline", {
      status: completed.goal.status,
      requests: observed.length,
      clampMilliseconds: 10000,
      resumedAfterDeadline: true,
    });
  });
  if (externalWakeDeadline !== undefined) {
    assert(Date.now() >= externalWakeDeadline);
    assert.equal(counts.get("external-wake"), 2, "External wake left a stale deadline continuation");
    record("external-wake-timer-cancelled", true);
  }
  await run("settings-and-elapsed", async () => {
    const session = await create("settings");
    const rpc = async (method, input) => {
      const reply = await client.rpc.call({ rpcID: "romm0109.goal", method, location: { directory: project }, input });
      assert(!reply.error, JSON.stringify(reply.error));
      return reply.output;
    };
    await rpc("configure", { sessionID: session.id, automaticTurns: 2, noProgressTurns: null });
    await command(session.id, "/goal scenario:settings verify settings safety limit");
    await until(
      () => state(session.id),
      (value) => value.goal?.status === "paused",
      "Settings safety limit did not pause Goal",
    );
    await wait(session.id);
    const snapshot = await rpc("get", { sessionID: session.id });
    assert.equal(snapshot.settings.automaticTurns, 2);
    assert.equal(snapshot.goal.automaticTurns, 2);
    assert.equal(snapshot.goal.noProgressTurnLimit, null);
    assert.equal(counts.get("settings"), 2);
    await pause(30);
    assert.equal((await rpc("get", { sessionID: session.id })).elapsedMs, snapshot.elapsedMs);
    record("settings-and-elapsed", {
      requests: counts.get("settings"),
      persistedLimit: 2,
      pausedElapsedMs: snapshot.elapsedMs,
    });
  });
  assert.equal(providerErrors.length, 0, providerErrors.join("\n"));
  assert(
    !results.some((item) => item.name.endsWith("-failed")),
    `Native Goal smoke failed; inspect evidence directory ${root}`,
  );
} finally {
  await writeFile(join(root, "results.json"), JSON.stringify(results, null, 2));
  await writeFile(join(root, "provider-requests.json"), JSON.stringify(requests, null, 2));
  await writeFile(join(root, "host.log"), output.replace(/server password \S+/g, "server password [redacted]"));
  provider.closeAllConnections();
  provider.close();
  ownedKill("SIGTERM");
  const hardStop = setTimeout(() => ownedKill("SIGKILL"), 1500);
  if (host.exitCode === null && host.signalCode === null)
    await new Promise((resolveExit) => host.once("exit", resolveExit));
  clearTimeout(hardStop);
  ownedKill("SIGKILL");
  console.log("Native Goal evidence:", root);
}
