import type { PluginContext } from "../plugin-types.ts";
import { MAX_MESSAGE_BYTES, type SessionJobRegistry } from "./coordination.ts";

const objectInput = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false as const,
});
const stringInput = (description: string, maxLength = MAX_MESSAGE_BYTES) => ({
  type: "string" as const,
  description,
  maxLength,
});
const result = (value: unknown) => ({ content: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
const MAX_WAIT_SECONDS = 2_147_483.647;

function createWaitSignal(parent: AbortSignal, timeoutSeconds?: number): { signal: AbortSignal; dispose(): void } {
  if (timeoutSeconds === undefined) return { signal: parent, dispose() {} };
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > MAX_WAIT_SECONDS) {
    throw new Error(`Wait timeout must be greater than 0 and no more than ${MAX_WAIT_SECONDS} seconds.`);
  }
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason ?? new Error("Wait cancelled."));
  if (parent.aborted) abortFromParent();
  else parent.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Wait timed out.")), timeoutSeconds * 1_000);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", abortFromParent);
    },
  };
}

export function registerSubagents(ctx: PluginContext, jobs: SessionJobRegistry): Promise<void> {
  return Promise.all([
    ctx.tool.transform((editor) => {
      editor.add({
        name: "subagent_spawn",
        description:
          "Start an isolated child OpenCode session for a self-contained task. It inherits the current agent and host permission behavior. Returns a job ID immediately after the child accepts the task.",
        input: objectInput(
          {
            task: stringInput("Self-contained task and expected result", 50_000),
            title: stringInput("Short label for the job", 120),
          },
          ["task"],
        ),
        execute: async (raw, execution) => {
          const input = raw as { task: string; title?: string };
          return result(await jobs.spawn(execution.sessionID, input.task, input.title, execution.signal));
        },
      });
      editor.add({
        name: "subagent_inspect",
        description: "List this session's child jobs without exposing their prompts or transcripts.",
        input: objectInput({}, []),
        execute: async (_raw, execution) => result(await jobs.list(execution.sessionID)),
      });
      editor.add({
        name: "subagent_send",
        description:
          "Send a parent message to an active child job, or send a child-originated request to the parent session.",
        input: objectInput(
          { jobID: stringInput("Active job ID; omit when calling from a child"), message: stringInput("Message text") },
          ["message"],
        ),
        execute: async (raw, execution) => {
          const input = raw as { jobID?: string; message: string };
          if (input.jobID) {
            await jobs.send(execution.sessionID, input.jobID, input.message);
            return result("Message delivered to the child session.");
          }
          const requestID = await jobs.sendFromChild(execution.sessionID, input.message);
          return result({ requestID, note: "Wait for the parent with subagent_wait." });
        },
      });
      editor.add({
        name: "subagent_respond",
        description: "Answer one request sent by an active child job.",
        input: objectInput(
          {
            requestID: stringInput("Request ID shown in the parent transcript", 80),
            message: stringInput("Response text"),
          },
          ["requestID", "message"],
        ),
        execute: async (raw, execution) => {
          const input = raw as { requestID: string; message: string };
          if (!(await jobs.respond(execution.sessionID, input.requestID, input.message)))
            throw new Error("Request is missing, already answered, or belongs to another parent session.");
          return result("Response delivered to the child.");
        },
      });
      editor.add({
        name: "subagent_wait",
        description:
          "Wait for a child job to finish (from its parent) or for a parent response (from a child). Cancelling this wait does not cancel the job.",
        input: objectInput(
          {
            jobID: stringInput("Job ID to wait for", 80),
            requestID: stringInput("Child request ID to wait for", 80),
            timeout: { type: "number" as const, description: "Optional wait timeout in seconds" },
          },
          [],
        ),
        execute: async (raw, execution) => {
          const input = raw as { jobID?: string; requestID?: string; timeout?: number };
          const waiting = createWaitSignal(execution.signal, input.timeout);
          try {
            if (input.requestID) {
              const parentID = await jobs.childParent(execution.sessionID);
              if (!parentID) throw new Error("Only an active child can wait for a parent response.");
              return result(await jobs.waitForResponse(execution.sessionID, input.requestID, waiting.signal));
            }
            if (!input.jobID) throw new Error("Provide a jobID or requestID.");
            return result(await jobs.wait(execution.sessionID, input.jobID, waiting.signal));
          } finally {
            waiting.dispose();
          }
        },
      });
      editor.add({
        name: "subagent_cancel",
        description: "Interrupt an active child job owned by this session.",
        input: objectInput({ jobID: stringInput("Active job ID", 80) }, ["jobID"]),
        execute: async (raw, execution) => {
          const { jobID } = raw as { jobID: string };
          return result(
            (await jobs.cancel(execution.sessionID, jobID))
              ? "Child job interrupted."
              : "No active child job with that ID.",
          );
        },
      });
    }),
    ctx.command.transform((editor) =>
      editor.add({
        name: "subagents",
        description: "Start or inspect isolated child-session jobs.",
        execute: async ({ sessionID, prompt }) => {
          const input = prompt.text.trim().replace(/^\/subagents\s*/i, "");
          if (!input || input === "list") {
            const rows = await jobs.list(sessionID);
            await ctx.session.synthetic({
              sessionID,
              text: rows.length
                ? JSON.stringify(
                    rows.map(({ id, title, status, createdAt }) => ({ id, title, status, createdAt })),
                    null,
                    2,
                  )
                : "No child jobs.",
              resume: false,
            });
            return;
          }
          const match = /^cancel\s+(\S+)$/i.exec(input);
          if (match) {
            await ctx.session.synthetic({
              sessionID,
              text: (await jobs.cancel(sessionID, match[1] ?? ""))
                ? "Child job interrupted."
                : "No active child job with that ID.",
              resume: false,
            });
            return;
          }
          const job = await jobs.spawn(sessionID, input, input.slice(0, 80));
          await ctx.session.synthetic({
            sessionID,
            text: `Started isolated child job ${job.id} in session ${job.childSessionID}. Use subagent_wait to collect its result or /subagents cancel ${job.id} to interrupt it.`,
            resume: false,
          });
        },
      }),
    ),
  ]).then(() => undefined);
}
