import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerProviderAccounts } from "../src/provider-context/accounts.ts";
import { boundedJsonContent } from "../src/provider-context/bounded-output.ts";
import { codexReplayDecision, parseCodexCheckpointProvenance } from "../src/provider-context/codex-provenance.ts";
import { parseRolloverState, registerContextManagement } from "../src/provider-context/context-management.ts";
import { registerProviderContextExtensions } from "../src/provider-context/index.ts";
import { OPENROUTER_ENDPOINT, requestJevDecision, TYPESAFE_ENDPOINT } from "../src/provider-context/jev-client.ts";
import { normalizeJevInput, normalizeJevResponse } from "../src/provider-context/jev-types.ts";
import { rerankSearchHits, searchWorkspace } from "../src/provider-context/search.ts";
import { registerTypesafeQuestion } from "../src/provider-context/typesafe.ts";
import { makeHistoryUnits, selectiveCompactionPlan } from "../src/provider-context/typesafe-compact.ts";
import { isProviderUsageEvent, registerProviderUsage, summarizeProviderUsage } from "../src/provider-context/usage.ts";

test("provider usage aggregates only bounded host token/cost fields", () => {
  const events = [
    {
      id: "e1",
      type: "session.step.ended",
      created: 1,
      data: { cost: 0.12, tokens: { input: 10, output: 4, reasoning: 3, cache: { read: 8, write: 1 } } },
    },
    {
      id: "e2",
      type: "session.step.ended",
      created: 2,
      data: { cost: 0.08, tokens: { input: 5, output: 2, reasoning: 0 } },
    },
  ];
  assert.equal(isProviderUsageEvent(events[0]), true);
  assert.equal(
    isProviderUsageEvent({ ...events[0], data: { ...events[0].data, tokens: { input: -1, output: 4, reasoning: 0 } } }),
    false,
  );
  assert.deepEqual(summarizeProviderUsage(events), {
    steps: 2,
    inputTokens: 15,
    outputTokens: 6,
    reasoningTokens: 3,
    cacheReadTokens: 8,
    cacheWriteTokens: 1,
    reportedCost: 0.2,
  });
});

test("usage event listener stores a redacted projection and awaits abort cleanup", async () => {
  const storage = new Map();
  const commands = new Map();
  let stored;
  let storedResolve;
  const saved = new Promise((resolve) => {
    storedResolve = resolve;
  });
  const ctx = {
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => {
        storage.set(key, value);
        stored = value;
        storedResolve();
      },
    },
    command: { transform: async (register) => register({ add: (value) => commands.set(value.name, value) }) },
    event: {
      subscribe: async function* ({ signal }) {
        yield {
          id: "usage-event",
          type: "session.step.ended",
          created: 10,
          data: {
            sessionID: "session-secret",
            cost: 0.25,
            tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 4 }, diagnostic: "private" },
            content: "must not persist",
          },
        };
        if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      },
    },
  };
  const cleanup = await registerProviderUsage(ctx);
  await saved;
  await cleanup();
  assert.deepEqual(stored, [
    {
      id: "usage-event",
      type: "session.step.ended",
      created: 10,
      data: { cost: 0.25, tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 4 } } },
    },
  ]);
});

test("provider account command lists providers without activating credentials", async () => {
  let command;
  let activationCalls = 0;
  const ctx = {
    provider: {
      list: async () => ({
        data: [
          {
            id: "synthetic-provider",
            name: "Fixture Provider",
            activation: "enabled",
            headers: { authorization: "secret" },
          },
        ],
      }),
    },
    credential: {
      activate: async () => {
        activationCalls++;
      },
    },
    command: {
      transform: async (register) =>
        register({
          add: (value) => {
            command = value;
          },
        }),
    },
    session: {
      synthetic: async (value) => {
        ctx.lastSynthetic = value;
      },
    },
  };
  await registerProviderAccounts(ctx);
  await command.execute({ sessionID: "session-fixture", prompt: { text: "" } });
  assert.match(ctx.lastSynthetic.text, /Fixture Provider/);
  assert.match(ctx.lastSynthetic.text, /no credential listing or session-scoped activation/);
  assert.doesNotMatch(ctx.lastSynthetic.text, /secret/);
  assert.equal(activationCalls, 0);
});

test("isolated module group registers expected commands/tools and cleans up its event stream", async () => {
  const commands = new Set();
  const tools = new Set();
  const ctx = {
    provider: { list: async () => ({ data: [] }) },
    options: {},
    location: { directory: "/tmp" },
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({ entries: [], nextCursor: undefined }),
    },
    command: { transform: async (register) => register({ add: (value) => commands.add(value.name) }) },
    tool: { transform: async (register) => register({ add: (value) => tools.add(value.name) }) },
    session: { synthetic: async () => {}, compact: async () => {} },
    event: { subscribe: async function* () {} },
  };
  const cleanup = await registerProviderContextExtensions(ctx);
  assert.deepEqual([...commands].sort(), [
    "codex-compact",
    "context-management",
    "provider-accounts",
    "provider-usage",
    "typesafe-compact",
  ]);
  assert.deepEqual([...tools].sort(), ["typesafe_question", "typesafe_search"]);
  await cleanup();
});

test("typesafe_question refuses missing auth before any transport or fallback", async () => {
  let tool;
  const ctx = {
    options: {},
    tool: {
      transform: async (register) =>
        register({
          add: (definition) => {
            tool = definition;
          },
        }),
    },
  };
  await registerTypesafeQuestion(ctx);
  await assert.rejects(
    tool.execute(
      { state: "synthetic", questions: { safe: { type: "noul", instructions: "Safe?" } } },
      { signal: new AbortController().signal },
    ),
    /no request was made/,
  );
});

test("TypeSafe fallback is explicitly gated, uses only OpenRouter, and never follows a failed primary request", async () => {
  let tool;
  const fallbackCtx = {
    options: { openRouterFallback: true, openRouterApiKey: "synthetic-openrouter-key" },
    tool: {
      transform: async (register) =>
        register({
          add: (definition) => {
            tool = definition;
          },
        }),
    },
  };
  const input = { state: "synthetic", questions: { safe: { type: "noul", instructions: "Safe?" } } };
  await registerTypesafeQuestion(fallbackCtx, async (url, init) => {
    assert.equal(url, OPENROUTER_ENDPOINT);
    assert.equal(init.headers.Authorization, "Bearer synthetic-openrouter-key");
    assert.equal(JSON.parse(init.body).model, "~typesafe/jev-latest");
    return new Response(JSON.stringify({ model: "jev-fixture", answers: { safe: { type: "noul", noul: 0.75 } } }), {
      status: 200,
    });
  });
  const output = await tool.execute(input, { signal: new AbortController().signal });
  assert.match(output.content, /0\.75/);

  let calls = 0;
  const primaryCtx = {
    options: {
      typesafeApiKey: "synthetic-typesafe-key",
      openRouterFallback: true,
      openRouterApiKey: "synthetic-openrouter-key",
    },
    tool: {
      transform: async (register) =>
        register({
          add: (definition) => {
            tool = definition;
          },
        }),
    },
  };
  await registerTypesafeQuestion(primaryCtx, async (url) => {
    calls++;
    assert.equal(url, TYPESAFE_ENDPOINT);
    return new Response("synthetic-typesafe-key body", { status: 503 });
  });
  await assert.rejects(
    tool.execute(input, { signal: new AbortController().signal }),
    /TypeSafe request failed with HTTP 503/,
  );
  assert.equal(calls, 1);
});

test("context rollover remains disabled by default and compacts only after session opt-in", async () => {
  const commands = new Map();
  const storage = new Map();
  const compacted = [];
  const synthetic = [];
  const ctx = {
    storage: { get: async (key) => storage.get(key), set: async (key, value) => storage.set(key, value) },
    command: { transform: async (register) => register({ add: (value) => commands.set(value.name, value) }) },
    session: { compact: async (input) => compacted.push(input), synthetic: async (input) => synthetic.push(input) },
  };
  assert.deepEqual(parseRolloverState({ version: 1, enabled: "true" }), { version: 1, enabled: false });
  await registerContextManagement(ctx);
  const command = commands.get("context-management");
  await command.execute({ sessionID: "parent-session", prompt: { text: "rollover" } });
  assert.equal(compacted.length, 0);
  await command.execute({ sessionID: "parent-session", prompt: { text: "enable" } });
  await command.execute({ sessionID: "fork-session", prompt: { text: "rollover" } });
  assert.equal(compacted.length, 0);
  await command.execute({ sessionID: "parent-session", prompt: { text: "rollover" } });
  assert.deepEqual(compacted, [{ sessionID: "parent-session" }]);
  assert.equal(synthetic.length, 3);
});

test("Codex replay gate requires exact provider, model, account, endpoint and protocol lineage", () => {
  const fixture = {
    version: 1,
    providerID: "openai-codex",
    modelID: "fixture-model",
    accountFingerprint: "a".repeat(64),
    endpointOrigin: "https://chatgpt.com",
    protocol: "remote-v2",
    checkpointID: "checkpoint-fixture-01",
    providerState: { response_id: "resp_fixture", opaque: { sequence: 3 } },
  };
  assert.deepEqual(parseCodexCheckpointProvenance(fixture), fixture);
  const same = {
    providerID: fixture.providerID,
    modelID: fixture.modelID,
    accountFingerprint: fixture.accountFingerprint,
    endpointOrigin: fixture.endpointOrigin,
    protocol: fixture.protocol,
  };
  assert.deepEqual(codexReplayDecision(fixture, same), { replay: true, providerState: fixture.providerState });
  assert.match(codexReplayDecision(fixture, { ...same, accountFingerprint: "b".repeat(64) }).reason, /account changed/);
  assert.match(
    codexReplayDecision(fixture, { providerID: same.providerID, modelID: same.modelID }).reason,
    /unavailable/,
  );
  assert.match(
    codexReplayDecision({ ...fixture, endpointOrigin: "https://u:p@host/path" }, same).reason,
    /incomplete or invalid/,
  );
});

test("Jev input and response validation preserve typed semantics", () => {
  const input = normalizeJevInput({
    state: { ticket: "synthetic" },
    questions: {
      urgent: { type: "noul", instructions: "Urgent?" },
      route: { type: "choice", instructions: "Team?", criteria: { billing: "Money", tech: "Bugs" } },
      score: { type: "score", instructions: "Level?", criteria: ["low", "high"] },
    },
  });
  const result = normalizeJevResponse(
    {
      model: "jev-fixture",
      answers: {
        urgent: { type: "noul", noul: 0.7 },
        route: { type: "choice", choice: "tech", probabilities: { billing: 0.1, tech: 0.9 }, confidence: 0.9 },
        score: {
          type: "score",
          score: 0.5,
          probabilities: { 0: 0.5, 1: 0.5 },
          legend: { 0: "low", 1: "high" },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 10, output_tokens: 4 },
    },
    input,
  );
  assert.equal(result.answers.route.type, "choice");
  assert.equal(result.usage.output_tokens, 4);
  assert.throws(() =>
    normalizeJevResponse(
      {
        model: "bad",
        answers: {
          urgent: { type: "noul", noul: 1.4 },
          route: { type: "choice", choice: "tech", probabilities: { billing: 0.8, tech: 0.2 }, confidence: 0.2 },
          score: {
            type: "score",
            score: 0,
            probabilities: { 0: 0.5, 1: 0.5 },
            legend: { 0: "low", 1: "high" },
            confidence: 0.5,
          },
        },
      },
      input,
    ),
  );
});

test("model-visible JSON tool output is capped by bytes and lines", () => {
  const result = boundedJsonContent({ content: "x".repeat(80_000) });
  assert.ok(Buffer.byteLength(result, "utf8") <= 50 * 1024);
  assert.equal(JSON.parse(result).truncated, true);
});

test("Jev client uses only the official endpoint, propagates abort, and never leaks response text in errors", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ model: "jev-fixture", answers: { ok: { type: "noul", noul: 0.9 } } }), {
      status: 200,
    });
  };
  const controller = new AbortController();
  const result = await requestJevDecision(
    { state: "synthetic", questions: { ok: { type: "noul", instructions: "Valid?" } } },
    "synthetic-api-key",
    controller.signal,
    fakeFetch,
  );
  assert.equal(result.answers.ok.noul, 0.9);
  assert.equal(calls[0].url, TYPESAFE_ENDPOINT);
  assert.equal(calls[0].init.headers.Authorization, "Bearer synthetic-api-key");
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    requestJevDecision(
      { state: "synthetic", questions: { ok: { type: "noul", instructions: "Valid?" } } },
      "synthetic-api-key",
      aborted.signal,
      async () => {
        throw new Error("should not reach fetch");
      },
    ),
    { name: "AbortError" },
  );
  await assert.rejects(
    requestJevDecision(
      { state: "x", questions: { ok: { type: "noul", instructions: "x" } } },
      "synthetic-api-key",
      new AbortController().signal,
      async () => new Response("synthetic-api-key raw error", { status: 503 }),
    ),
    (error) => !error.message.includes("synthetic-api-key"),
  );
});

test("semantic search uses explicit Jev answers and a scripted transport", async () => {
  const hits = [
    { path: "a.md", startLine: 1, endLine: 2, text: "lexical match", score: 0.9 },
    { path: "b.md", startLine: 7, endLine: 8, text: "better semantic match", score: 0.4 },
  ];
  const ranked = await rerankSearchHits(
    hits,
    "question",
    "synthetic-api-key",
    new AbortController().signal,
    async (url, init) => {
      assert.equal(url, TYPESAFE_ENDPOINT);
      assert.equal(init.redirect, "error");
      const request = JSON.parse(init.body);
      assert.equal(request.questions.hit_1.type, "noul");
      return new Response(
        JSON.stringify({
          model: "jev-fixture",
          answers: { hit_0: { type: "noul", noul: 0.1 }, hit_1: { type: "noul", noul: 0.95 } },
        }),
        { status: 200 },
      );
    },
  );
  assert.equal(ranked[0].path, "b.md");
  assert.equal(ranked[0].semantic, 0.95);
});

test("selective compaction adapter preserves selected versus retained units and cancellation", async () => {
  const messages = [
    { role: "user", content: "Keep the API invariant." },
    { role: "assistant", content: [{ type: "text", text: "Verified it." }] },
  ];
  const units = makeHistoryUnits(messages);
  assert.equal(units.length, 2);
  assert.equal(
    makeHistoryUnits([{ role: "assistant", providerState: { checkpoint: "opaque" }, content: "x" }]),
    undefined,
  );
  const result = await selectiveCompactionPlan(
    units,
    async (_input) => ({
      model: "fixture",
      answers: { [units[0].id]: { type: "noul", noul: 0.9 }, [units[1].id]: { type: "noul", noul: 0.1 } },
    }),
    async (selected) => `Summary of ${selected[0].text}`,
    new AbortController().signal,
  );
  assert.equal(result.selected.length, 1);
  assert.equal(result.retained.length, 1);
  assert.match(result.summary, /Retained history/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    selectiveCompactionPlan(
      units,
      async () => {
        throw new Error("should not evaluate");
      },
      async () => "unused",
      abort.signal,
    ),
    { name: "AbortError" },
  );
});

test("SQLite FTS5 search returns exact line ranges, skips symlinks, and rejects path escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-context-search-"));
  try {
    await mkdir(join(root, "docs"));
    await writeFile(
      join(root, "docs", "notes.md"),
      "# Notes\n\nThe zebra protocol keeps request IDs stable.\nA second paragraph follows.\n",
    );
    await writeFile(join(root, "docs", "ignore.bin"), Buffer.from([0, 1, 2]));
    const outside = await mkdtemp(join(tmpdir(), "provider-context-outside-"));
    try {
      await writeFile(join(outside, "secret.md"), "zebra outside the project");
      await symlink(outside, join(root, "docs", "external"));
      const hits = await searchWorkspace(root, "docs", "zebra protocol", new AbortController().signal);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].path, "docs/notes.md");
      assert.equal(hits[0].startLine, 1);
      assert.equal(hits[0].endLine, 5);
      await assert.rejects(
        searchWorkspace(root, "../", "zebra", new AbortController().signal),
        /inside the current project/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
