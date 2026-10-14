import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../scripts/fixtures/lsp-server.cjs", import.meta.url), "utf8");

function fixture() {
  let receive;
  const messages = [];
  vm.runInNewContext(source, {
    Buffer,
    process: {
      stdin: {
        on: (event, handler) => {
          assert.equal(event, "data");
          receive = handler;
        },
      },
      stdout: { write: (frame) => messages.push(JSON.parse(frame.split("\r\n\r\n")[1])) },
      exit: () => assert.fail("fixture exited unexpectedly"),
    },
  });
  const send = (...values) =>
    receive(
      Buffer.from(
        values
          .map((value) => {
            const body = JSON.stringify({ jsonrpc: "2.0", ...value });
            return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
          })
          .join(""),
      ),
    );
  send({ method: "initialized", params: {} });
  assert.equal(messages.shift().method, "workspace/configuration");
  return { send, messages };
}

for (const configurationFirst of [true, false]) {
  test(`LSP fixture waits for configuration with configuration first: ${configurationFirst}`, () => {
    const server = fixture();
    if (configurationFirst) server.send({ id: 101, result: [{}, {}] });
    server.send(
      { id: 2, method: "textDocument/diagnostic", params: {} },
      { id: 3, method: "textDocument/diagnostic", params: {} },
    );
    if (!configurationFirst) {
      assert.deepEqual(server.messages, [], "no stale diagnostics before the configuration reply");
      server.send({ id: 101, result: [{}, {}] });
    }
    assert.deepEqual(
      server.messages.map((message) => message.id),
      [2, 3],
    );
    for (const message of server.messages) assert.equal(message.result.items[0].code, "fixture-2");
    server.messages.length = 0;
    server.send({ id: 4, method: "textDocument/diagnostic", params: {} });
    assert.equal(server.messages[0].result.items[0].code, "fixture-2");
  });
}

test("LSP fixture preserves malformed configuration evidence instead of assuming success", () => {
  const server = fixture();
  server.send({ id: 2, method: "textDocument/diagnostic", params: {} });
  server.send({ id: 101, result: null });
  assert.equal(server.messages[0].result.items[0].code, "fixture--1");
});
