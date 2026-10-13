import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CaffeinateController, resolveInhibitorCommand } from "../src/utilities/caffeinate.ts";
import { loadEnvFile } from "../src/utilities/dotenv.ts";
import { formatPullRequest, parsePullRequest } from "../src/utilities/github-pr.ts";
import { registerUtilityExtensions } from "../src/utilities/index.ts";
import {
  applyTextEdits,
  normalizeLspServers,
  resolveServerLaunch,
  runDiagnostics,
  runFix,
  selectLspServer,
  selectLspServers,
} from "../src/utilities/lsp.ts";
import { fetchQuotes, formatQuote, normalizeSymbols, parseQuote } from "../src/utilities/ticker.ts";
import { registerUtilityTui } from "../src/utilities/tui.ts";

test("GitHub PR parser summarizes checks, reviews, comments, draft and lifecycle state", () => {
  const status = parsePullRequest({
    number: 42,
    url: "https://github.com/acme/repo/pull/42",
    state: "OPEN",
    isDraft: true,
    reviewDecision: "CHANGES_REQUESTED",
    latestReviews: [
      { state: "APPROVED", author: { login: "a" } },
      { state: "CHANGES_REQUESTED", author: { login: "b" } },
    ],
    statusCheckRollup: [
      { state: "SUCCESS" },
      { state: "FAILURE" },
      { state: "COMPLETED", conclusion: "FAILURE" },
      { state: "IN_PROGRESS" },
    ],
    comments: { totalCount: 3 },
  });
  assert.deepEqual(status.checks, { passing: 1, failing: 2, pending: 1 });
  assert.deepEqual(status.reviews, { approved: ["a"], changesRequested: ["b"], commented: [] });
  assert.equal(status.comments, 3);
  assert.match(formatPullRequest(status), /PR #42 · draft · OPEN/);
  assert.throws(() => parsePullRequest({}), /invalid pull request response/);
});

test("caffeinate controller balances concurrent sessions, mode replacement, disable and shutdown using mocked drivers", async () => {
  const started = [];
  const stopped = [];
  const controller = new CaffeinateController(async (mode) => {
    started.push(mode);
    let active = true;
    return {
      stop: () => {
        if (active) {
          active = false;
          stopped.push(mode);
        }
      },
    };
  });
  await controller.event("session.execution.started", "s1");
  await controller.event("session.execution.started", "s2");
  assert.equal(controller.activeCount, 2);
  assert.deepEqual(started, ["display"]);
  await controller.event("session.execution.succeeded", "s1");
  assert.equal(stopped.length, 0);
  await controller.setMode("sleep");
  assert.deepEqual(started, ["display", "sleep"]);
  assert.deepEqual(stopped, ["display"]);
  await controller.setEnabled(false);
  assert.deepEqual(stopped, ["display", "sleep"]);
  await controller.event("session.execution.interrupted", "s2");
  assert.equal(controller.activeCount, 0);
  await controller.shutdown();
  assert.equal(resolveInhibitorCommand("sleep", "darwin")?.command, "sh");
  assert.equal(resolveInhibitorCommand("display", "unknown"), undefined);
});

test("dotenv requires an explicit readable file, preserves inherited values, and reports names only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-dotenv-"));
  try {
    const file = path.join(root, ".env");
    await writeFile(file, "EXISTING=secret-shell\nAPI_KEY=secret-file\nEMPTY=\n");
    const env = { EXISTING: "shell", PATH: "/bin" };
    const result = await loadEnvFile(".env", { cwd: root, env });
    assert.equal(env.EXISTING, "shell");
    assert.equal(env.API_KEY, "secret-file");
    assert.equal(env.EMPTY, "");
    assert.deepEqual(result.loaded, ["API_KEY", "EMPTY"]);
    assert.deepEqual(result.preserved, ["EXISTING"]);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    await assert.rejects(loadEnvFile("", { cwd: root, env }), /explicit-file-path/);
    await assert.rejects(loadEnvFile("missing", { cwd: root, env }), /Could not read/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ticker validates symbols and parses Yahoo chart fixture responses without network", async () => {
  assert.deepEqual(normalizeSymbols(["msft, NVDA", "msft"]), ["MSFT", "NVDA"]);
  assert.throws(() => normalizeSymbols(["$"]), /Invalid stock symbol/);
  const payload = {
    chart: {
      result: [{ meta: { regularMarketPrice: 110, previousClose: 100, currency: "USD", regularMarketTime: 10 } }],
    },
  };
  assert.equal(parseQuote("MSFT", payload).changePercent, 10);
  assert.match(formatQuote({ symbol: "MSFT", quote: parseQuote("MSFT", payload) }), /\$110.00 \+10.00 \(\+10.00%\)/);
  const urls = [];
  const response = await fetchQuotes(["MSFT", "BAD"], undefined, async (input) => {
    urls.push(String(input));
    if (String(input).includes("BAD")) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  assert.equal(response[0].quote.price, 110);
  assert.match(response[1].error, /HTTP 503/);
  assert.ok(urls.every((url) => url.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/")));
});

test("LSP config routing, edits, fixture server diagnostics, preview and explicit write", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-lsp-"));
  try {
    const file = path.join(root, "sample.fixture");
    await writeFile(file, "value\n");
    const servers = normalizeLspServers([
      {
        name: "fixture",
        command: process.execPath,
        args: [path.resolve("scripts/fixtures/lsp-server.cjs")],
        extensions: [".fixture"],
        languageId: "plaintext",
      },
    ]);
    const server = selectLspServer(servers, "sample.fixture");
    assert.equal(server.name, "fixture");
    assert.deepEqual(
      selectLspServers([...servers, { ...server, name: "fixture-2" }], "sample.fixture").map((item) => item.name),
      ["fixture", "fixture-2"],
    );
    const result = await runDiagnostics(server, root, ["sample.fixture"], undefined, 2_000);
    assert.equal(result[0].diagnostics[0].message, "Fixture warning");
    assert.equal(
      result[0].diagnostics[0].code,
      "fixture-2",
      "workspace/configuration receives an empty object for each requested item",
    );
    assert.equal(result[0].path, "sample.fixture");
    const preview = await runFix(server, root, "sample.fixture", undefined, false, undefined, 2_000);
    assert.equal(preview.changed, true);
    assert.equal(preview.written, false);
    assert.equal(await readFile(file, "utf8"), "value\n");
    const applied = await runFix(server, root, "sample.fixture", undefined, true, undefined, 2_000);
    assert.equal(applied.written, true);
    assert.equal(await readFile(file, "utf8"), "// fixed\nvalue\n");
    assert.equal(
      applyTextEdits("abc", [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "A" },
      ]),
      "Abc",
    );
    await assert.rejects(runDiagnostics(server, root, ["../outside.fixture"]), /outside the workspace/);
    assert.throws(
      () => normalizeLspServers([{ name: "invalid", command: "x", args: [], extensions: ["fixture"] }]),
      /Invalid OpenCode LSP server/,
    );
    const windows = resolveServerLaunch(
      {
        name: "fixture",
        command: "C:\\tools\\fixture.cmd",
        args: ["--stdio", "file name"],
        extensions: [".fixture"],
        languageId: "text",
      },
      "C:\\project",
      "win32",
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    );
    assert.equal(windows.command, "C:\\Windows\\System32\\cmd.exe");
    assert.match(windows.args[3], /fixture\.cmd.*file name/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TUI adapter claims a native panel, registers commands, and releases event listeners", async () => {
  const slots = [];
  const commands = [];
  const listeners = [];
  const serverCommands = [];
  const data = {
    on: (_type, handler) => {
      listeners.push(handler);
      return () => {
        listeners.splice(listeners.indexOf(handler), 1);
      };
    },
  };
  const state = { symbols: [], quotes: [], loading: false, activeExecutions: 0 };
  const ctx = {
    storage: { store: (_key, _options) => [state, (mutate) => mutate(state)] },
    data,
    ui: {
      slot: (slot) => slots.push(slot),
      panel: { open: () => true },
      router: { current: () => ({ type: "session", sessionID: "session-fixture" }) },
      tabs: { list: () => [] },
      dialog: { prompt: async () => undefined },
      toast: { show() {} },
    },
    client: { session: { command: async (input) => serverCommands.push(input) } },
    location: undefined,
    keymap: { layer: (factory) => commands.push(...factory().commands) },
  };
  const cleanup = await registerUtilityTui(ctx, async () => ({ jsx: (_type, props) => props }));
  assert.equal(slots[0].append, "session.panel");
  assert.deepEqual(
    commands.map((item) => item.slash.name),
    ["utilities", "github-pr", "ticker", "caffeinate"],
  );
  await commands[3].run("off");
  assert.deepEqual(serverCommands, [{ sessionID: "session-fixture", name: "caffeinate", text: "off" }]);
  assert.equal(listeners.length, 4);
  await cleanup();
  assert.equal(listeners.length, 0);
});

test("server group registers native tools and commands and aborts its event subscription on cleanup", async () => {
  const commands = new Map();
  const tools = new Map();
  let streamSignal;
  const context = {
    location: { directory: process.cwd(), project: { id: "fixture" } },
    options: { servers: [] },
    storage: { get: async () => undefined, set: async () => {} },
    command: { transform: async (register) => register({ add: (item) => commands.set(item.name, item) }) },
    tool: { transform: async (register) => register({ add: (item) => tools.set(item.name, item) }) },
    event: {
      subscribe: ({ signal }) => {
        streamSignal = signal;
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          },
        };
      },
    },
    session: { synthetic: async () => {} },
  };
  const cleanup = await registerUtilityExtensions(context);
  assert.deepEqual([...commands.keys()].sort(), ["caffeinate", "dotenv", "github-pr", "ticker"]);
  assert.deepEqual([...tools.keys()].sort(), ["lsp_diagnostics", "lsp_fix", "stock_quote"]);
  assert.equal(streamSignal.aborted, false);
  await cleanup();
  await new Promise(setImmediate);
  assert.equal(streamSignal.aborted, true);
});
