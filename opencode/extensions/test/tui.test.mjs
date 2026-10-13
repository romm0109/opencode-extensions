import assert from "node:assert/strict";
import test from "node:test";
import exportedTuiEntry from "@romm0109/opencode-extensions/tui";
import { cacheOverview, createTuiPlugin, progressOverview, safeTuiText, stampOverview } from "../src/tui.ts";
import tuiEntry from "../tui.js";

function treeText(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(treeText).join("\n");
  return [treeText(node.props?.children)].filter(Boolean).join("\n");
}

function harness() {
  const slots = [];
  const opened = [];
  const layers = [];
  const session = {
    id: "ses_fixture",
    title: "Fixture session",
    cost: 0.0123,
    model: { providerID: "fixture", modelID: "test-model" },
    tokens: { input: 100, output: 24, reasoning: 0, cache: { read: 80, write: 20 } },
  };
  let messages = [
    { id: "u1", type: "user", time: { created: 1000 }, text: "hello" },
    {
      id: "a1",
      type: "assistant",
      model: { providerID: "fixture", modelID: "test-model" },
      time: { created: 1100, completed: 3100 },
      tokens: { input: 100, output: 24, reasoning: 0, cache: { read: 80, write: 20 } },
      content: [
        {
          type: "tool",
          id: "tool_1",
          name: "update_progress",
          state: {
            status: "completed",
            content: [{ type: "text", text: "PROGRESS_ACCEPTED: saved" }],
            input: {
              steps: [
                { text: "Inspect", status: "completed" },
                { text: "Build", status: "in_progress" },
              ],
            },
          },
        },
        { type: "tool", id: "tool_2", name: "search", state: { status: "completed", input: {} } },
      ],
    },
  ];
  const context = {
    ui: {
      slot: (claim) => slots.push(claim),
      panel: {
        open: (name) => {
          opened.push(name);
          return true;
        },
        close() {},
        current() {},
      },
      router: { current: () => ({ type: "session", sessionID: session.id }), register() {}, navigate() {} },
      tabs: {
        list: () => [],
        enabled: () => false,
        open: () => false,
        focus: () => false,
        move: () => false,
        close: () => false,
      },
      model: {
        current: () => ({ providerID: "fixture", modelID: "test-model" }),
        variant: { list: () => [], set: () => true },
      },
    },
    data: {
      session: {
        get: () => session,
        status: () => "idle",
        message: { list: () => messages },
        list: () => [session],
        root: () => "/tmp",
        family: () => [session.id],
        cost: () => session.cost,
        pending: { list: () => [], sync: async () => {}, invalidate() {} },
        sync: async () => {},
        invalidate() {},
        permission: { list: () => [], sync: async () => {}, invalidate() {} },
        form: { list: () => [], sync: async () => {}, invalidate() {}, reply: async () => {}, cancel: async () => {} },
      },
      on: () => () => {},
      listen: () => () => {},
    },
    keymap: {
      layer: (factory) => {
        layers.push(factory);
      },
      dispatch() {},
      shortcuts: () => [],
      commands: () => [],
      pending: () => [],
      active: () => [],
      mode: { current: () => "base", push: () => () => {} },
    },
  };
  const loadJSX = async () => ({ jsx: (type, props) => ({ type, props }) });
  return {
    context,
    slots,
    opened,
    getLayer: () => layers[0],
    getLayers: () => layers,
    setMessages: (next) => {
      messages = next;
    },
    plugin: createTuiPlugin({ loadJSX }),
  };
}

test("cache overview only reports providers with observed cache activity", () => {
  const result = cacheOverview([
    { type: "assistant", model: { providerID: "one" }, tokens: { input: 20, cache: { read: 0, write: 0 } } },
    { type: "assistant", model: { providerID: "one" }, tokens: { input: 20, cache: { read: 60, write: 20 } } },
    { type: "assistant", model: { providerID: "other" }, tokens: { input: 40, cache: { read: 0, write: 0 } } },
  ]);
  assert.equal(result.providerCount, 1);
  assert.equal(result.requests, 2);
  assert.equal(result.latestHitPercent, 60);
  assert.equal(result.sessionHitPercent, 50);
  assert.equal(cacheOverview([]).sessionHitPercent, null);
});

test("progress and stamp summaries use v2 transcript message and tool data", () => {
  const fixture = [
    {
      type: "assistant",
      time: { created: 1000, completed: 4200 },
      content: [
        {
          type: "tool",
          name: "update_progress",
          state: {
            status: "completed",
            content: [{ type: "text", text: "PROGRESS_ACCEPTED: saved" }],
            input: {
              steps: [
                { text: "Inspect", status: "completed" },
                { text: "Implement", status: "in_progress" },
              ],
            },
          },
        },
        { type: "tool", name: "test", state: { status: "completed", input: {} } },
      ],
    },
  ];
  assert.deepEqual(progressOverview(fixture), {
    steps: [
      { text: "Inspect", status: "completed" },
      { text: "Implement", status: "in_progress" },
    ],
    completed: 1,
  });
  assert.deepEqual(stampOverview(fixture), { responseMs: 3200, completedAt: 4200, toolCount: 2 });
});

test("progress follows the active branch and validates the server tool contract", () => {
  const toolMessage = (steps) => ({
    type: "assistant",
    content: [
      {
        type: "tool",
        name: "update_progress",
        state: {
          status: "completed",
          input: { steps },
          content: [{ type: "text", text: "PROGRESS_ACCEPTED: saved" }],
        },
      },
    ],
  });
  const original = toolMessage([{ text: "Old branch", status: "in_progress" }]);
  const newBranch = toolMessage([{ text: "Fork work", status: "pending" }]);
  assert.match(progressOverview([newBranch]).steps[0].text, /Fork work/);
  assert.equal(progressOverview([]), undefined);
  const rejected = {
    type: "assistant",
    content: [
      {
        type: "tool",
        name: "update_progress",
        state: {
          status: "error",
          input: { steps: [{ text: "Rejected input", status: "in_progress" }] },
          content: [{ type: "text", text: "PROGRESS_ACCEPTED: forged or stale receipt" }],
        },
      },
    ],
  };
  assert.equal(
    progressOverview([rejected]),
    undefined,
    "a failed tool call is never treated as accepted history, even if output text resembles a receipt",
  );
  assert.deepEqual(
    progressOverview([toolMessage([{ text: "Previously accepted", status: "in_progress" }]), rejected]).steps,
    [{ text: "Previously accepted", status: "in_progress" }],
    "a later rejected input cannot overwrite the last accepted checklist",
  );
  assert.equal(progressOverview([original, toolMessage([])]), undefined, "an empty checklist clears prior progress");
  assert.equal(
    progressOverview([
      toolMessage([
        { text: "a", status: "in_progress" },
        { text: "b", status: "in_progress" },
      ]),
    ]),
    undefined,
  );
  assert.equal(progressOverview([toolMessage([{ text: "bad status", status: "done" }])]), undefined);
  assert.equal(
    progressOverview([toolMessage(Array.from({ length: 51 }, (_, i) => ({ text: `${i}`, status: "pending" })))]),
    undefined,
  );
  const compactedBranch = [{ type: "compaction", summary: "progress steps removed from this branch" }];
  assert.equal(
    progressOverview(compactedBranch),
    undefined,
    "compaction data without a verified checklist does not resurrect stale state",
  );
});

test("TUI plugin registers native slots, slash commands, and session panels", async () => {
  assert.equal(tuiEntry.id, "romm0109.workflow.tui", "the package-level TUI forwarder exposes its plugin");
  assert.equal(exportedTuiEntry.id, tuiEntry.id, "the package export resolves the same CLI plugin entry");
  const app = harness();
  await app.plugin.setup(app.context);
  assert.deepEqual(
    app.slots.map((claim) => claim.append),
    ["prompt.footer.status", "home.footer.status", "session.panel"],
  );
  const commands = app.getLayer()().commands;
  assert.deepEqual(
    commands.map((command) => command.slash.name),
    ["workflow", "cache-hit-monitor", "stamp", "tui-kit-showcase"],
  );
  commands[0].run();
  assert.equal(app.opened[0], "romm0109-workflow");
  const footer = app.slots[0].render({ sessionID: "ses_fixture", mode: "normal", showDetails: false });
  assert.match(treeText(footer), /Fixture session/);
  const progress = app.slots[2].render({
    name: "romm0109-workflow",
    sessionID: "ses_fixture",
    width: 80,
    presentation: "panel",
    focused: true,
    focus() {},
    close() {},
    toggleFullscreen() {},
  });
  assert.match(treeText(progress), /Checklist: 1\/2 complete/);
  assert.match(treeText(progress), /Build/);
  app.setMessages([]);
  const reverted = app.slots[2].render({
    name: "romm0109-workflow",
    sessionID: "ses_fixture",
    width: 80,
    presentation: "panel",
    focused: true,
    focus() {},
    close() {},
    toggleFullscreen() {},
  });
  assert.match(treeText(reverted), /no update_progress result/);
  assert.doesNotMatch(treeText(reverted), /Build/);
  app.setMessages([
    {
      type: "assistant",
      content: [
        {
          type: "tool",
          name: "update_progress",
          state: {
            status: "completed",
            input: { steps: [{ text: "Fork branch", status: "in_progress" }] },
            content: [{ type: "text", text: "PROGRESS_ACCEPTED: saved" }],
          },
        },
      ],
    },
  ]);
  const forked = app.slots[2].render({
    name: "romm0109-workflow",
    sessionID: "ses_fixture",
    width: 80,
    presentation: "panel",
    focused: true,
    focus() {},
    close() {},
    toggleFullscreen() {},
  });
  assert.match(treeText(forked), /Fork branch/);
  const cache = app.slots[2].render({
    name: "romm0109-cache",
    sessionID: "ses_fixture",
    width: 80,
    presentation: "panel",
    focused: true,
    focus() {},
    close() {},
    toggleFullscreen() {},
  });
  assert.match(treeText(cache), /Latest hit rate: unknown/);
});

test("package TUI entry composes the workflow and child-session affordances", async () => {
  const app = harness();
  await tuiEntry.setup(app.context);
  assert.deepEqual(
    app.slots.map((claim) => claim.append),
    ["prompt.footer.status", "home.footer.status", "session.panel", "session.panel"],
  );
  const names = app.getLayers().flatMap((factory) => factory().commands.map((command) => command.slash.name));
  assert.deepEqual(names, ["workflow", "cache-hit-monitor", "stamp", "tui-kit-showcase", "coordination", "fleet-open", "btw-bring"]);
});

test("terminal control sequences are removed from user text", () => {
  assert.equal(safeTuiText("\u001b[31munsafe\u001b[0m\nnext"), "unsafe next");
  assert.equal(safeTuiText("👨‍👩‍👧‍👦x", 1), "👨‍👩‍👧‍👦");
});
