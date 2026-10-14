import type { Context } from "@opencode/plugin/tui/context";

const PANEL = "romm0109-coordination";
type JSX = { jsx: (type: string, props: Record<string, unknown>) => unknown };
type Dependencies = { loadJSX?: () => Promise<JSX> };

function safeText(value: unknown, limit = 240): string {
  if (typeof value !== "string") return "";
  const escapeChar = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const ansi = new RegExp(
    `${escapeChar}(?:\\][^${bell}]*(?:${bell}|${escapeChar}\\\\)|\\[[0-?]*[ -/]*[@-~]|[@-_])`,
    "gu",
  );
  let clean = "";
  for (const character of value.replace(ansi, "")) {
    const code = character.charCodeAt(0);
    clean += code <= 31 || (code >= 127 && code <= 159) ? " " : character;
  }
  return clean.replace(/\s+/gu, " ").trim().slice(0, limit);
}

function latestAssistant(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i] as Record<string, unknown> | undefined;
    if (row?.type !== "assistant" || !Array.isArray(row.content)) continue;
    const answer = row.content
      .flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const item = part as Record<string, unknown>;
        return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
      })
      .join("")
      .trim();
    if (answer) return truncateUtf8(answer, 40_000);
  }
  return undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let length = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (length + bytes > maxBytes) break;
    result += character;
    length += bytes;
  }
  return result;
}

function currentSession(ctx: Context): string | undefined {
  const route = ctx.ui.router.current();
  if (route.type === "session") return route.sessionID;
  return ctx.ui.tabs.list().find((tab) => tab.active)?.sessionID;
}

function sessionRows(ctx: Context, jsx: JSX, parentID: string) {
  const family = ctx.data.session.family(parentID);
  const rows = family.flatMap((id) => {
    if (id === parentID) return [];
    const session = ctx.data.session.get(id);
    if (!session) return [];
    const title = safeText(session.title, 100) || id.slice(0, 12);
    const status = ctx.data.session.status(id);
    return [jsx.jsx("text", { children: `${status === "running" ? "●" : "○"} ${title}  ${id}` })];
  });
  return jsx.jsx("box", {
    flexDirection: "column",
    padding: 1,
    children: rows.length ? rows : jsx.jsx("text", { children: "No child sessions are available." }),
  });
}

/** TUI-only native session-tab and explicit bring-back affordances. */
export function createCoordinationTui(dependencies: Dependencies = {}) {
  const loadJSX =
    dependencies.loadJSX ??
    (async () => {
      const name: string = "@opentui/solid/jsx-runtime";
      return (await import(name)) as unknown as JSX;
    });
  return {
    id: "romm0109.coordination.tui",
    async setup(ctx: Context) {
      const jsx = await loadJSX();
      ctx.ui.slot({
        append: "session.panel",
        render: (input) => (input.name === PANEL ? (sessionRows(ctx, jsx, input.sessionID) as never) : (null as never)),
      });
      ctx.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "romm0109.coordination.panel",
            title: "Child sessions",
            description: "Inspect child sessions in this session family",
            palette: true,
            slash: { name: "coordination" },
            run: () => {
              ctx.ui.panel.open(PANEL);
            },
          },
          {
            id: "romm0109.coordination.open",
            title: "Open child session",
            description: "Open a child session in a native OpenCode tab",
            palette: true,
            slash: { name: "fleet-open", arguments: true },
            run: (input) => {
              const target = input?.trim();
              if (!target) return;
              const parentID = currentSession(ctx);
              if (!parentID || !ctx.data.session.family(parentID).includes(target)) return;
              ctx.ui.tabs.open(target);
            },
          },
          {
            id: "romm0109.coordination.bring",
            title: "Bring back side-session answer",
            description: "Append the latest child answer as a synthetic transcript message",
            palette: true,
            slash: { name: "btw-bring", arguments: true },
            run: async (input) => {
              const parentID = currentSession(ctx);
              if (!parentID) return;
              const childID = input?.trim();
              if (!childID || !ctx.data.session.family(parentID).includes(childID)) return;
              const answer = latestAssistant(ctx.data.session.message.list(childID));
              if (!answer) return;
              await ctx.client.session.synthetic({
                sessionID: parentID,
                text: `Side-session answer from ${childID}:\n\n${answer}`,
                resume: false,
              });
            },
          },
        ],
      }));
    },
  };
}

export default createCoordinationTui();
