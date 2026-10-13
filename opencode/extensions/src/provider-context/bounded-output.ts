const MAX_BYTES = 50 * 1024
const MAX_LINES = 2_000
const PREVIEW_CHARS = 6_000

/** Return safe, bounded JSON text for a model-visible tool result. */
export function boundedJsonContent(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2)
  const totalBytes = Buffer.byteLength(serialized, "utf8")
  const totalLines = serialized.split("\n").length
  if (totalBytes <= MAX_BYTES && totalLines <= MAX_LINES) return serialized
  const preview = serialized.slice(0, PREVIEW_CHARS)
  const limited = JSON.stringify({ truncated: true, totalBytes, totalLines, preview }, null, 2)
  return Buffer.byteLength(limited, "utf8") <= MAX_BYTES ? limited : JSON.stringify({ truncated: true, totalBytes, totalLines, message: "Output exceeded the tool result limit; narrow the request." })
}
