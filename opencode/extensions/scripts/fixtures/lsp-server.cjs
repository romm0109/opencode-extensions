let pending = Buffer.alloc(0)
let configurationCount = -1
function send(value) {
  const text = JSON.stringify(value)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`)
}
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk])
  while (true) {
    const boundary = pending.indexOf("\r\n\r\n")
    if (boundary < 0) return
    const length = Number(/Content-Length:\s*(\d+)/i.exec(pending.subarray(0, boundary).toString("ascii"))?.[1])
    if (!Number.isFinite(length) || pending.length < boundary + 4 + length) return
    const body = pending.subarray(boundary + 4, boundary + 4 + length)
    pending = pending.subarray(boundary + 4 + length)
    const message = JSON.parse(body.toString("utf8"))
    if (message.method === "exit") { process.exit(0); return }
    if (message.method === "initialized") { send({ jsonrpc: "2.0", id: 101, method: "workspace/configuration", params: { items: [{ section: "first" }, { section: "second" }] } }); continue }
    if (message.id === 101 && !message.method) { configurationCount = Array.isArray(message.result) ? message.result.length : -1; continue }
    if (message.id === undefined) continue
    let result = null
    if (message.method === "initialize") result = { capabilities: { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false }, codeActionProvider: true } }
    if (message.method === "textDocument/diagnostic") result = { kind: "full", items: [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, severity: 2, code: `fixture-${configurationCount}`, message: "Fixture warning", source: "fixture-lsp" }] }
    if (message.method === "textDocument/codeAction") {
      const uri = message.params.textDocument.uri
      result = [{ title: "Add marker", kind: "source.fixAll", edit: { changes: { [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "// fixed\n" }] } } }]
    }
    send({ jsonrpc: "2.0", id: message.id, result })
  }
})
