import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { PluginContext } from "../plugin-types.ts";

export const DOTENV_MAX_BYTES = 1024 * 1024;

/** Parse and apply only an explicitly selected dotenv file. Existing process values win. */
export async function loadEnvFile(
  path: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ path: string; loaded: string[]; preserved: string[] }> {
  if (!path.trim()) throw new Error("Usage: /dotenv load <explicit-file-path>");
  const fullPath = isAbsolute(path) ? path : resolve(options.cwd ?? process.cwd(), path);
  let bytes: Buffer;
  try {
    const info = await stat(fullPath);
    if (!info.isFile()) throw new Error("selected path is not a regular file");
    if (info.size > DOTENV_MAX_BYTES) throw new Error(`file exceeds ${DOTENV_MAX_BYTES} bytes`);
    bytes = await readFile(fullPath);
  } catch (error) {
    if (error instanceof Error && error.message.includes("not a regular file"))
      throw new Error("The selected dotenv path is not a regular file.");
    if (error instanceof Error && error.message.includes("exceeds"))
      throw new Error("The selected dotenv file is too large.");
    throw new Error("Could not read the explicitly selected dotenv file.");
  }
  if (bytes.length > DOTENV_MAX_BYTES) throw new Error("The selected dotenv file is too large.");
  const content = bytes.toString("utf8").replace(/^\uFEFF/u, "");
  let parsed: Record<string, string | undefined>;
  try {
    parsed = parseEnv(content);
  } catch {
    throw new Error("Could not parse the selected dotenv file.");
  }
  const env = options.env ?? process.env;
  const loaded: string[] = [];
  const preserved: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    if (env[key] === undefined) {
      env[key] = value;
      loaded.push(key);
    } else preserved.push(key);
  }
  return { path: fullPath, loaded, preserved };
}

export async function registerDotenv(context: PluginContext): Promise<void> {
  await context.command.transform((editor) =>
    editor.add({
      name: "dotenv",
      description: "Load missing environment variables from one explicitly selected dotenv file",
      execute: async ({ sessionID, prompt }) => {
        const args = prompt.text.replace(/^\/dotenv\s*/i, "").trim();
        const match = /^load\s+(.+?)\s*$/s.exec(args);
        if (!match?.[1]) throw new Error("Usage: /dotenv load <explicit-file-path>");
        const result = await loadEnvFile(match[1], { cwd: context.location.directory });
        const loaded = result.loaded.length ? result.loaded.join(", ") : "none";
        const preserved = result.preserved.length ? ` Existing values kept: ${result.preserved.join(", ")}.` : "";
        await context.session.synthetic({
          sessionID,
          text: `Loaded variable names: ${loaded}.${preserved} Values are hidden. The file affects this OpenCode process and child processes until restart.`,
          resume: false,
        });
      },
    }),
  );
}
