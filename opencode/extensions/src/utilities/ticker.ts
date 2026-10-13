import type { PluginContext } from "../plugin-types.ts"

export const QUOTE_ENDPOINT = "https://query1.finance.yahoo.com/v8/finance/chart"
export const QUOTE_TIMEOUT_MS = 10_000
export const MAX_TICKER_SYMBOLS = 10
export type Quote = { symbol: string; price: number; previousClose: number; change: number; changePercent: number; currency?: string; marketTime?: number }
export type QuoteResult = { symbol: string; quote?: Quote; error?: string; stale?: boolean }

export function normalizeSymbols(input: Iterable<string>, allowEmpty = false): string[] {
  const symbols = [...new Set([...input].flatMap((item) => item.split(/[\s,]+/)).map((item) => item.trim().toUpperCase()).filter(Boolean))]
  if (!allowEmpty && symbols.length === 0) throw new Error("Provide at least one stock symbol.")
  if (symbols.length > MAX_TICKER_SYMBOLS) throw new Error(`At most ${MAX_TICKER_SYMBOLS} stock symbols are supported.`)
  const invalid = symbols.find((item) => !/^[A-Z0-9.^=-]{1,15}$/.test(item))
  if (invalid) throw new Error(`Invalid stock symbol: ${invalid}`)
  return symbols
}

export function parseQuote(symbol: string, payload: unknown): Quote {
  const chart = record(record(payload)?.chart)
  const row = Array.isArray(chart?.result) ? record(chart.result[0]) : undefined
  const meta = record(row?.meta)
  const price = number(meta?.regularMarketPrice)
  const previousClose = number(meta?.previousClose) ?? number(meta?.chartPreviousClose)
  if (price === undefined || previousClose === undefined || previousClose === 0) throw new Error("Quote response did not include a usable price and previous close.")
  const currency = meta?.currency === "GBp" ? "GBp" : typeof meta?.currency === "string" && /^[A-Z]{3}$/.test(meta.currency) ? meta.currency : undefined
  const marketTime = number(meta?.regularMarketTime)
  return { symbol, price, previousClose, change: price - previousClose, changePercent: ((price - previousClose) / previousClose) * 100, ...(currency ? { currency } : {}), ...(marketTime === undefined ? {} : { marketTime: marketTime * 1000 }) }
}

export async function fetchQuotes(symbols: readonly string[], signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<QuoteResult[]> {
  return Promise.all(symbols.map(async (symbol) => {
    try {
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(QUOTE_TIMEOUT_MS)]) : AbortSignal.timeout(QUOTE_TIMEOUT_MS)
      const response = await fetcher(`${QUOTE_ENDPOINT}/${encodeURIComponent(symbol)}?interval=1m&range=1d`, { headers: { "User-Agent": "opencode-extensions/1.0" }, signal: requestSignal })
      if (!response.ok) throw new Error(`Quote request failed with HTTP ${response.status}.`)
      return { symbol, quote: parseQuote(symbol, await response.json()) }
    } catch (error) {
      if (signal?.aborted) throw error
      return { symbol, error: error instanceof Error ? error.message : String(error) }
    }
  }))
}

export function formatQuote(result: QuoteResult): string {
  if (!result.quote) return `${result.symbol}: unavailable (${result.error ?? "unknown error"})`
  const q = result.quote
  const currency = currencyPrefix(q.currency)
  const value = formatMarketNumber(q.price)
  const price = q.currency === "GBp" ? `${value}p` : `${currency}${value}`
  const sign = q.change >= 0 ? "+" : ""
  return `${q.symbol}: ${price} ${sign}${formatMarketNumber(q.change)} (${sign}${q.changePercent.toFixed(2)}%)${result.stale ? " stale" : ""}`
}

export function mergeQuoteResults(current: readonly QuoteResult[], results: readonly QuoteResult[]): QuoteResult[] {
  const previous = new Map(current.map((item) => [item.symbol, item]))
  return results.map((result) => result.quote ? result : previous.get(result.symbol)?.quote ? { symbol: result.symbol, quote: previous.get(result.symbol)!.quote, error: result.error, stale: true } : result)
}

export async function registerTicker(context: PluginContext, fetcher: typeof fetch = fetch): Promise<void> {
  await context.tool.transform((editor) => editor.add({
    name: "stock_quote",
    description: "Fetch current market quotes for up to ten Yahoo Finance symbols.",
    input: { type: "object", properties: { symbols: { type: "array", minItems: 1, maxItems: MAX_TICKER_SYMBOLS, items: { type: "string" } } }, required: ["symbols"], additionalProperties: false },
    execute: async (input, call) => {
      const symbols = normalizeSymbols((input as { symbols: string[] }).symbols)
      const results = await fetchQuotes(symbols, call.signal, fetcher)
      return { content: results.map(formatQuote).join("\n"), metadata: { quotes: results } }
    },
  }))
  await context.command.transform((editor) => editor.add({
    name: "ticker", description: "Show stock quotes or fetch symbols", execute: async ({ sessionID, prompt }) => {
      const args = prompt.text.replace(/^\/ticker\s*/i, "").trim()
      if (!args || args === "help") {
        await context.session.synthetic({ sessionID, text: "Usage: /ticker <SYMBOL ...>\nQuotes are fetched from Yahoo Finance when explicitly requested; network tests use fixtures.", resume: false }); return
      }
      const symbols = normalizeSymbols(args.split(/[\s,]+/))
      const results = await fetchQuotes(symbols, undefined, fetcher)
      await context.session.synthetic({ sessionID, text: results.map(formatQuote).join("\n"), resume: false })
    },
  }))
}

function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined }
function formatMarketNumber(value: number) {
  const absolute = Math.abs(value)
  if (absolute === 0) return "0.00"
  const magnitude = Math.floor(Math.log10(absolute))
  const decimals = 6 - magnitude - 1
  const formatted = decimals > 8 ? value.toPrecision(6) : value.toFixed(Math.max(2, decimals))
  const [coefficient, exponent] = formatted.split("e")
  const [integer = formatted, fraction = ""] = coefficient?.split(".") ?? [formatted, ""]
  let tail = fraction
  while (tail.length > (exponent === undefined ? 2 : 0) && tail.endsWith("0")) tail = tail.slice(0, -1)
  return `${tail ? `${integer}.${tail}` : integer}${exponent === undefined ? "" : `e${exponent}`}`
}
function currencyPrefix(currency: string | undefined) {
  switch (currency) {
    case "USD": return "$"
    case "EUR": return "€"
    case "GBP": return "£"
    case "JPY": return "¥"
    case "CAD": return "C$"
    case "HKD": return "HK$"
    case "TWD": return "NT$"
    default: return currency && currency !== "GBp" ? `${currency} ` : ""
  }
}
