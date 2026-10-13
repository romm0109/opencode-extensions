import { normalizeJevInput, normalizeJevResponse, type JevDecisionInput, type JevDecisionResponse } from "./jev-types.ts"

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const TIMEOUT_MS = 10_000

export async function requestJevDecision(
  rawInput: unknown,
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<JevDecisionResponse> {
  return requestAtEndpoint(rawInput, apiKey, signal, fetchImpl, TYPESAFE_ENDPOINT, "jev-latest", "TypeSafe")
}

/** Explicit OpenRouter fallback. Callers must gate this on their opt-in setting. */
export async function requestOpenRouterJevDecision(
  rawInput: unknown,
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<JevDecisionResponse> {
  return requestAtEndpoint(rawInput, apiKey, signal, fetchImpl, OPENROUTER_ENDPOINT, "~typesafe/jev-latest", "OpenRouter")
}

async function requestAtEndpoint(
  rawInput: unknown,
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  endpoint: string,
  model: string,
  providerName: "TypeSafe" | "OpenRouter",
): Promise<JevDecisionResponse> {
  if (!apiKey.trim() || /\s/u.test(apiKey)) throw new Error(`${providerName} API key is missing or invalid`)
  const input: JevDecisionInput = normalizeJevInput(rawInput)
  const body = JSON.stringify({ model, ...input })
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) throw new Error(`${providerName} request exceeds 1 MiB`)
  signal.throwIfAborted()
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const requestSignal = AbortSignal.any([signal, timeout])
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body,
    signal: requestSignal,
    redirect: "error",
  })
  const text = await readBounded(response, requestSignal)
  if (!response.ok) throw new Error(`${providerName} request failed with HTTP ${response.status}`)
  let payload: unknown
  try { payload = JSON.parse(text) as unknown } catch { throw new Error(`${providerName} returned invalid JSON`) }
  try { return normalizeJevResponse(payload, input) } catch (error) { throw new Error(`${providerName} returned an invalid result: ${safeError(error)}`) }
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("TypeSafe response exceeds 1 MiB") }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "invalid response"
  return message.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 300)
}
