import { Plugin } from "@opencode/plugin";
import { registerAnalytics } from "./analytics.ts";
import { registerAdditionalExtensions } from "./feature-modules.ts";
import { registerGoal } from "./goal.ts";
import { registerNotesRecall } from "./notes-recall.ts";
import { registerPlan } from "./plan.ts";
import { registerCoordinationGroup } from "./coordination/index.ts";

type ProgressStatus = "pending" | "in_progress" | "completed" | "blocked";
type ProgressStep = { text: string; status: ProgressStatus };

const PROGRESS_STATUSES = new Set<ProgressStatus>(["pending", "in_progress", "completed", "blocked"]);

function graphemeCount(value: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length;
}

function validSteps(value: unknown): ProgressStep[] | undefined {
  if (!Array.isArray(value) || value.length > 50) return undefined;
  const result: ProgressStep[] = [];
  let activeCount = 0;
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const row = item as Record<string, unknown>;
    if (typeof row.text !== "string" || !row.text.trim() || graphemeCount(row.text) > 503) return undefined;
    if (typeof row.status !== "string" || !PROGRESS_STATUSES.has(row.status as ProgressStatus)) return undefined;
    if (row.status === "in_progress" && ++activeCount > 1) return undefined;
    result.push({ text: row.text, status: row.status as ProgressStatus });
  }
  return result;
}

function renderProgress(steps: ProgressStep[]): string {
  const icon: Record<ProgressStatus, string> = {
    pending: "[ ]",
    in_progress: "[~]",
    completed: "[x]",
    blocked: "[!]",
  };
  return steps.map((step) => `${icon[step.status]} ${step.text}`).join("\n");
}

export default Plugin.define({
  id: "romm0109.workflow",
  async setup(ctx) {
    const cleanup = await registerGoal(ctx);
    const cleanupAnalytics = await registerAnalytics(ctx);
    const cleanupCoordination = await registerCoordinationGroup(ctx);
    await registerPlan(ctx);
    await registerNotesRecall(ctx);
    await registerAdditionalExtensions(ctx);
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "update_progress",
        options: { codemode: false },
        description: "Replace this session's current progress snapshot. An empty steps array clears progress.",
        input: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              maxItems: 50,
              items: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
                },
                required: ["text", "status"],
                additionalProperties: false,
              },
            },
          },
          required: ["steps"],
          additionalProperties: false,
        },
        execute: async (input) => {
          const steps = validSteps((input as { steps?: unknown }).steps);
          if (!steps)
            throw new Error(
              "Supply at most 50 steps; each requires text (up to 503 graphemes) and a valid status, with at most one in_progress step.",
            );
          if (steps.length === 0) return { content: "PROGRESS_ACCEPTED: cleared for this session." };
          return { content: `PROGRESS_ACCEPTED: saved for this session.\n${renderProgress(steps)}` };
        },
      });
    });

    return async () => {
      cleanup();
      cleanupAnalytics();
      await cleanupCoordination();
    };
  },
});
