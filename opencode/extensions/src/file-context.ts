import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PluginContext } from "./plugin-types.ts";

const MAX_FILE_BYTES = 1_000_000;
const MAX_QUOTE_BYTES = 50_000;
const MAX_QUOTE_LINES = 500;

export interface FileContextSelection {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** Read an explicitly selected project file or line range without following symlinks. */
export async function readFileContext(
  root: string,
  inputPath: string,
  startLine = 1,
  endLine?: number,
): Promise<FileContextSelection> {
  if (!inputPath || isAbsolute(inputPath) || inputPath.includes("\0")) {
    throw new Error("Choose a relative file path inside the current project.");
  }
  const canonicalRoot = await realpath(root);
  const candidate = resolve(canonicalRoot, inputPath);
  if (!isWithin(canonicalRoot, candidate)) throw new Error("File path is outside the current project.");
  const candidateInfo = await lstat(candidate);
  if (candidateInfo.isSymbolicLink()) throw new Error("Symbolic links are not accepted for file context.");
  const canonicalFile = await realpath(candidate);
  if (!isWithin(canonicalRoot, canonicalFile)) throw new Error("File path resolves outside the current project.");
  const info = await lstat(canonicalFile);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("File context only reads regular files.");
  if (info.size > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} bytes.`);
  const handle = await open(
    canonicalFile,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new Error("File changed while it was being opened safely.");
    }
    if (opened.size > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} bytes.`);
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} bytes.`);
    const content = bytes.subarray(0, offset);
    if (content.includes(0)) throw new Error("Binary files cannot be attached as text context.");
    const lines = content.toString("utf8").replace(/\r\n?/g, "\n").split("\n");
    const end = endLine ?? lines.length;
    if (
      !Number.isInteger(startLine) ||
      !Number.isInteger(end) ||
      startLine < 1 ||
      end < startLine ||
      end > lines.length
    ) {
      throw new Error(`Line range must be within 1–${lines.length}.`);
    }
    if (end - startLine + 1 > MAX_QUOTE_LINES) throw new Error(`A quote may contain at most ${MAX_QUOTE_LINES} lines.`);
    const text = lines.slice(startLine - 1, end).join("\n");
    if (Buffer.byteLength(text) > MAX_QUOTE_BYTES)
      throw new Error(`A quote may contain at most ${MAX_QUOTE_BYTES} bytes.`);
    return { path: relative(canonicalRoot, canonicalFile).split(sep).join("/"), startLine, endLine: end, text };
  } finally {
    await handle.close();
  }
}

export function formatFileQuote(selection: FileContextSelection): string {
  return `<user_file_quote path="${escapeAttribute(selection.path)}" lines="${selection.startLine}-${selection.endLine}">\n${selection.text}\n</user_file_quote>`;
}

export async function registerFileContext(context: PluginContext): Promise<void> {
  await context.command.transform((editor) => {
    editor.add({
      name: "file-context",
      description: "Attach an explicitly selected project file or line range to this session",
      execute: async ({ sessionID, prompt }) => {
        const argument = prompt.text.replace(/^\/file-context\s*/i, "").trim();
        const match = /^(.*?)\s+(\d+)(?::|-)(\d+)\s*$/.exec(argument);
        const inputPath = match ? match[1]?.trim() : argument;
        if (!inputPath) throw new Error("Usage: /file-context <relative-path> [start:end]");
        const selection = await readFileContext(
          context.location.directory,
          inputPath,
          match ? Number(match[2]) : 1,
          match ? Number(match[3]) : undefined,
        );
        const quote = formatFileQuote(selection);
        await context.session.prompt({
          sessionID,
          text: `Use this exact project snapshot as context. Do not reread it unless asked.\n\n${quote}`,
        });
      },
    });
  });
}

function isWithin(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
