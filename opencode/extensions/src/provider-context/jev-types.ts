/**
 * MIT-derived TypeSafe/jev shapes and semantic validation, adapted from
 * packages/pi-typesafe/src/{types,validation}.ts in narumiruna/pi-extensions.
 * The exact source commit is 30ec29b06e3e09a205076683fcec4fdac39c504e.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type StructuredValue = string | JsonValue[] | { [key: string]: JsonValue };

export type JevQuestion =
  | { type: "noul"; instructions: StructuredValue; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: StructuredValue; criteria: Record<string, StructuredValue | null> }
  | { type: "score"; instructions: StructuredValue; criteria: StructuredValue[] };

export interface JevDecisionInput {
  state: StructuredValue;
  questions: Record<string, JevQuestion>;
}

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: "score";
      score: number;
      legend: Record<string, StructuredValue>;
      probabilities: Record<string, number>;
      confidence: number;
    };

export interface JevDecisionResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens: number; output_tokens: number; cost?: number };
}

const QUESTION_FIELDS = new Set(["type", "instructions", "criteria"]);
const PROBABILITY_TOLERANCE = 0.02;

export function normalizeJevInput(value: unknown): JevDecisionInput {
  const input = record(value, "input");
  const state = structured(input.state, "state");
  const questions = record(input.questions, "questions");
  const entries = Object.entries(questions);
  if (entries.length < 1 || entries.length > 128) throw new Error("questions must contain 1–128 typed questions");
  const normalized: Record<string, JevQuestion> = Object.create(null);
  for (const [id, raw] of entries) {
    if (!id.trim() || id.length > 128) throw new Error("question ids must be non-empty and at most 128 characters");
    const question = record(raw, `questions.${id}`);
    for (const field of Object.keys(question))
      if (!QUESTION_FIELDS.has(field)) throw new Error(`questions.${id}.${field} is not supported`);
    const instructions = structured(question.instructions, `questions.${id}.instructions`);
    if (question.type === "noul") {
      let criteria: { true: string; false: string } | undefined;
      if (question.criteria !== undefined) {
        const value = record(question.criteria, `questions.${id}.criteria`);
        if (
          Object.keys(value).some((key) => key !== "true" && key !== "false") ||
          typeof value.true !== "string" ||
          typeof value.false !== "string"
        ) {
          throw new Error(`questions.${id}.criteria must contain only string true and false descriptions`);
        }
        criteria = { true: value.true, false: value.false };
      }
      normalized[id] = { type: "noul", instructions, ...(criteria ? { criteria } : {}) };
      continue;
    }
    if (question.type === "choice") {
      const values = record(question.criteria, `questions.${id}.criteria`);
      const keys = Object.keys(values);
      if (keys.length < 2 || keys.length > 255 || keys.some((key) => !key.trim()))
        throw new Error(`questions.${id}.criteria needs 2–255 named choices`);
      const criteria: Record<string, StructuredValue | null> = Object.create(null);
      for (const key of keys)
        criteria[key] = values[key] === null ? null : structured(values[key], `questions.${id}.criteria.${key}`);
      normalized[id] = { type: "choice", instructions, criteria };
      continue;
    }
    if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10)
        throw new Error(`questions.${id}.criteria needs 2–10 ordered levels`);
      normalized[id] = {
        type: "score",
        instructions,
        criteria: question.criteria.map((item, index) => structured(item, `questions.${id}.criteria[${index}]`)),
      };
      continue;
    }
    throw new Error(`questions.${id}.type must be noul, choice, or score`);
  }
  return { state, questions: normalized };
}

export function normalizeJevResponse(value: unknown, input: JevDecisionInput): JevDecisionResponse {
  const response = record(value, "response");
  if (typeof response.model !== "string" || !response.model.trim()) throw new Error("response.model must be non-empty");
  const raw = record(response.answers, "response.answers");
  exactKeys(raw, Object.keys(input.questions), "response.answers");
  const answers: Record<string, JevAnswer> = Object.create(null);
  for (const [id, question] of Object.entries(input.questions))
    answers[id] = normalizeAnswer(raw[id], question, `response.answers.${id}`);
  let usage: JevDecisionResponse["usage"];
  if (response.usage !== undefined) {
    const rawUsage = record(response.usage, "response.usage");
    const inputTokens = rawUsage.input_tokens ?? rawUsage.prompt_tokens;
    const outputTokens = rawUsage.output_tokens ?? rawUsage.completion_tokens;
    if (
      !Number.isSafeInteger(inputTokens) ||
      (inputTokens as number) < 0 ||
      !Number.isSafeInteger(outputTokens) ||
      (outputTokens as number) < 0
    )
      throw new Error("response.usage token counts must be non-negative integers");
    if (
      rawUsage.cost !== undefined &&
      (typeof rawUsage.cost !== "number" || !Number.isFinite(rawUsage.cost) || rawUsage.cost < 0)
    )
      throw new Error("response.usage.cost must be a non-negative number");
    usage = {
      input_tokens: inputTokens as number,
      output_tokens: outputTokens as number,
      ...(typeof rawUsage.cost === "number" ? { cost: rawUsage.cost } : {}),
    };
  }
  return { model: response.model, answers, ...(usage ? { usage } : {}) };
}

function normalizeAnswer(value: unknown, question: JevQuestion, path: string): JevAnswer {
  const answer = record(value, path);
  if (answer.type !== question.type) throw new Error(`${path}.type does not match the requested question`);
  if (question.type === "noul") {
    if (!probability(answer.noul)) throw new Error(`${path}.noul must be between 0 and 1`);
    return { type: "noul", noul: answer.noul };
  }
  if (question.type === "choice") {
    const probabilities = probabilityMap(answer.probabilities, Object.keys(question.criteria), `${path}.probabilities`);
    if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice))
      throw new Error(`${path}.choice must name a requested option`);
    const choice = answer.choice;
    if (Object.values(probabilities).some((amount) => amount > (probabilities[choice] ?? 0)))
      throw new Error(`${path}.choice must name a highest-probability option`);
    if (!probability(answer.confidence)) throw new Error(`${path}.confidence must be between 0 and 1`);
    return { type: "choice", choice, probabilities, confidence: answer.confidence };
  }
  if (
    !Number.isFinite(answer.score) ||
    typeof answer.score !== "number" ||
    answer.score < 0 ||
    answer.score > question.criteria.length - 1
  )
    throw new Error(`${path}.score is outside the requested levels`);
  const levelKeys = question.criteria.map((_, index) => String(index));
  const probabilities = probabilityMap(answer.probabilities, levelKeys, `${path}.probabilities`);
  const expected = levelKeys.reduce((total, level) => total + Number(level) * (probabilities[level] ?? 0), 0);
  if (Math.abs(answer.score - expected) > PROBABILITY_TOLERANCE * Math.max(1, question.criteria.length - 1))
    throw new Error(`${path}.score must match the probability-weighted level distribution`);
  if (!probability(answer.confidence)) throw new Error(`${path}.confidence must be between 0 and 1`);
  const legend = record(answer.legend, `${path}.legend`);
  exactKeys(legend, levelKeys, `${path}.legend`);
  for (let index = 0; index < levelKeys.length; index++)
    if (!jsonEqual(legend[String(index)], question.criteria[index]))
      throw new Error(`${path}.legend.${index} must match the requested score criterion`);
  return {
    type: "score",
    score: answer.score,
    legend: legend as Record<string, StructuredValue>,
    probabilities,
    confidence: answer.confidence,
  };
}

function probabilityMap(value: unknown, keys: string[], path: string): Record<string, number> {
  const map = record(value, path);
  exactKeys(map, keys, path);
  const result: Record<string, number> = Object.create(null);
  let total = 0;
  for (const key of keys) {
    const amount = map[key];
    if (!probability(amount)) throw new Error(`${path}.${key} must be between 0 and 1`);
    result[key] = amount;
    total += amount;
  }
  if (Math.abs(total - 1) > PROBABILITY_TOLERANCE) throw new Error(`${path} probabilities must sum to 1`);
  return result;
}

function structured(value: unknown, path: string): StructuredValue {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return validateJson(value, path, new Set()) as JsonValue[];
  if (plainRecord(value)) return validateJson(value, path, new Set()) as { [key: string]: JsonValue };
  throw new Error(`${path} must be a string, JSON object, or JSON array`);
}

function validateJson(value: unknown, path: string, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error(`${path} must not contain circular data`);
    const next = new Set(ancestors).add(value);
    return value.map((item, index) => validateJson(item, `${path}[${index}]`, next));
  }
  if (plainRecord(value)) {
    if (ancestors.has(value)) throw new Error(`${path} must not contain circular data`);
    const next = new Set(ancestors).add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, validateJson(item, `${path}.${key}`, next)]),
    );
  }
  throw new Error(`${path} must contain only JSON values`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!plainRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value: Record<string, unknown>, keys: string[], path: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw new Error(`${path} must contain exactly the requested keys`);
}
function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  if (!plainRecord(left) || !plainRecord(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
  );
}
function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
