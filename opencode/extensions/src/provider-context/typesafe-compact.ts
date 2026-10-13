import type { JevDecisionInput, JevDecisionResponse } from "./jev-types.ts";

export interface HistoryUnit {
  id: string;
  order: number;
  role: "user" | "assistant";
  text: string;
}
export interface SelectiveCompactionPlan {
  selected: HistoryUnit[];
  retained: HistoryUnit[];
  summary: string;
}
export type EvaluateUnits = (input: JevDecisionInput, signal: AbortSignal) => Promise<JevDecisionResponse>;
export type SummarizeUnits = (units: readonly HistoryUnit[], signal: AbortSignal) => Promise<string>;

const MAX_UNITS = 128;
const MAX_UNIT_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const THRESHOLD = 0.5;

/** Extract only plain text messages; provider/tool/image state forces native fallback. */
export function makeHistoryUnits(messages: readonly unknown[]): HistoryUnit[] | undefined {
  const units: HistoryUnit[] = [];
  let total = 0;
  for (const raw of messages) {
    if (!isRecord(raw) || Object.hasOwn(raw, "providerState") || Object.hasOwn(raw, "providerResultState"))
      return undefined;
    const role = raw.role;
    if (role !== "user" && role !== "assistant") continue;
    let text: string | undefined;
    if (typeof raw.content === "string") text = raw.content;
    else if (
      Array.isArray(raw.content) &&
      raw.content.every((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
    )
      text = raw.content.map((part) => part.text).join("\n");
    if (text === undefined) return undefined;
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_UNIT_BYTES) return undefined;
    total += bytes;
    if (total > MAX_TOTAL_BYTES || units.length >= MAX_UNITS) return undefined;
    units.push({ id: `message_${String(units.length).padStart(3, "0")}`, order: units.length, role, text });
  }
  return units.length ? units : undefined;
}

/**
 * Testable adapter core. Cancellation, malformed results, empty selections, or
 * model summary failures propagate so the host can keep its native compaction.
 */
export async function selectiveCompactionPlan(
  units: readonly HistoryUnit[],
  evaluate: EvaluateUnits,
  summarize: SummarizeUnits,
  signal: AbortSignal,
): Promise<SelectiveCompactionPlan> {
  signal.throwIfAborted();
  if (!units.length || units.length > MAX_UNITS) throw new Error("history unit count is outside the supported range");
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const unit of units) {
    const bytes = Buffer.byteLength(unit.text, "utf8");
    if (
      !unit.id ||
      unit.id.length > 128 ||
      ids.has(unit.id) ||
      (unit.role !== "user" && unit.role !== "assistant") ||
      bytes > MAX_UNIT_BYTES
    )
      throw new Error("history units are invalid or exceed their bounds");
    ids.add(unit.id);
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("history exceeds the supported total size");
  }
  const input: JevDecisionInput = {
    state: {
      task: "Select history units to summarize while preserving useful context",
      units: units.map(({ id, role, text }) => ({ id, role, text })),
    },
    questions: Object.fromEntries(
      units.map((unit) => [
        unit.id,
        {
          type: "noul" as const,
          instructions: `Should this message be included in the compacted summary? Preserve durable decisions, constraints, progress, and unresolved work. Message: ${unit.text.slice(0, MAX_UNIT_BYTES)}`,
        },
      ]),
    ),
  };
  const response = await evaluate(input, signal);
  signal.throwIfAborted();
  const selected: HistoryUnit[] = [];
  const retained: HistoryUnit[] = [];
  for (const unit of units) {
    const answer = response.answers[unit.id];
    if (answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
      throw new Error(`TypeSafe omitted a valid decision for ${unit.id}`);
    (answer.noul >= THRESHOLD ? selected : retained).push(unit);
  }
  if (!selected.length) throw new Error("TypeSafe selected no history for summarization");
  const summary = await summarize(selected, signal);
  signal.throwIfAborted();
  if (!summary.trim() || Buffer.byteLength(summary, "utf8") > MAX_TOTAL_BYTES)
    throw new Error("summary is empty or exceeds the supported limit");
  const retainedBlock = retained.length
    ? `\n\nRetained history (quoted as untrusted transcript data):\n${JSON.stringify(retained.map(({ id, role, text }) => ({ id, role, text })))}`
    : "";
  const combined = `${summary.trim()}${retainedBlock}`;
  if (Buffer.byteLength(combined, "utf8") > MAX_TOTAL_BYTES)
    throw new Error("combined compaction result exceeds the supported limit");
  return { selected, retained, summary: combined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
