import type { PluginContext } from "../plugin-types.ts";
import { boundedJsonContent } from "./bounded-output.ts";
import { requestJevDecision, requestOpenRouterJevDecision } from "./jev-client.ts";
import type { JevDecisionResponse } from "./jev-types.ts";

const jsonValue = {
  anyOf: [{ type: "string" }, { type: "object", additionalProperties: {} }, { type: "array", items: {} }],
};
const typedQuestion = {
  oneOf: [
    {
      type: "object",
      properties: {
        type: { const: "noul" },
        instructions: jsonValue,
        criteria: {
          type: "object",
          properties: { true: { type: "string" }, false: { type: "string" } },
          required: ["true", "false"],
          additionalProperties: false,
        },
      },
      required: ["type", "instructions"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "choice" },
        instructions: jsonValue,
        criteria: {
          type: "object",
          minProperties: 2,
          maxProperties: 255,
          additionalProperties: { anyOf: [jsonValue, { type: "null" }] },
        },
      },
      required: ["type", "instructions", "criteria"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "score" },
        instructions: jsonValue,
        criteria: { type: "array", minItems: 2, maxItems: 10, items: jsonValue },
      },
      required: ["type", "instructions", "criteria"],
      additionalProperties: false,
    },
  ],
};

export async function registerTypesafeQuestion(ctx: PluginContext, fetchImpl: typeof fetch = fetch): Promise<void> {
  await ctx.tool.transform((editor) =>
    editor.add({
      name: "typesafe_question",
      description:
        "Ask TypeSafe Jev typed noul, choice, or score questions. Uses TypeSafe directly when configured; an explicitly enabled OpenRouter fallback is used only when the TypeSafe key is absent. It never switches providers after a request fails and honors cancellation.",
      input: {
        type: "object",
        properties: {
          state: { ...jsonValue, description: "The shared string, JSON object, or JSON array to evaluate." },
          questions: { type: "object", minProperties: 1, maxProperties: 128, additionalProperties: typedQuestion },
        },
        required: ["state", "questions"],
        additionalProperties: false,
      },
      execute: async (input, execution) => {
        const key = ctx.options.typesafeApiKey;
        let result: JevDecisionResponse;
        if (typeof key === "string" && key.trim()) {
          result = await requestJevDecision(input, key, execution.signal, fetchImpl);
        } else if (ctx.options.openRouterFallback === true) {
          const fallbackKey = ctx.options.openRouterApiKey;
          if (typeof fallbackKey !== "string" || !fallbackKey.trim())
            throw new Error("OpenRouter fallback is enabled but openRouterApiKey is missing; no request was made");
          result = await requestOpenRouterJevDecision(input, fallbackKey, execution.signal, fetchImpl);
        } else {
          throw new Error(
            "typesafe_question requires typesafeApiKey or explicit OpenRouter fallback configuration; no request was made",
          );
        }
        execution.signal.throwIfAborted();
        return { content: boundedJsonContent(result), metadata: result.usage ? { usage: result.usage } : undefined };
      },
    }),
  );
}
