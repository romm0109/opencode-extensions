import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { PluginContext } from "../plugin-types.ts";
import { boundedJsonContent } from "./bounded-output.ts";
import { requestJevDecision } from "./jev-client.ts";

const MAX_FILES = 600;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 5 * 1024;
const MAX_RESULTS = 20;
const INCLUDED_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".sh",
  ".sql",
  ".html",
  ".css",
  ".xml",
]);
const SKIPPED = new Set([".git", "node_modules", "dist", "build", ".opencode", ".next", "vendor", "coverage"]);

type FtsStatement = { run(...parameters: unknown[]): unknown; all(...parameters: unknown[]): unknown[] };
type FtsDatabase = { exec(sql: string): unknown; prepare(sql: string): FtsStatement; close(): void };

async function openMemoryDatabase(): Promise<FtsDatabase> {
  const runtime = globalThis as typeof globalThis & { Bun?: unknown };
  if (runtime.Bun) {
    const bunModule = "bun:sqlite";
    const sqlite = (await import(bunModule)) as { Database: new (path: string) => FtsDatabase };
    return new sqlite.Database(":memory:");
  }
  const sqlite = (await import("node:sqlite")) as { DatabaseSync: new (path: string) => FtsDatabase };
  return new sqlite.DatabaseSync(":memory:");
}

export interface SearchChunk {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}
export interface SearchHit extends SearchChunk {
  score: number;
  semantic?: number;
}

/** Local, throwaway FTS5 index. It never writes project files or a persistent database. */
export async function searchWorkspace(
  rootInput: string,
  pathInput: string,
  queryInput: string,
  signal: AbortSignal,
  limit = 8,
): Promise<SearchHit[]> {
  signal.throwIfAborted();
  const root = await realpath(rootInput);
  const requested = resolve(root, pathInput || ".");
  const rel = relative(root, requested);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(pathInput))
    throw new Error("Search path must stay inside the current project");
  const base = await realpath(requested);
  const baseRel = relative(root, base);
  if (baseRel === ".." || baseRel.startsWith(`..${sep}`))
    throw new Error("Search path resolves outside the current project");
  const terms =
    queryInput
      .normalize("NFKC")
      .match(/[\p{L}\p{N}_$-]+/gu)
      ?.slice(0, 16) ?? [];
  if (terms.length === 0) return [];
  const chunks = await discoverChunks(root, base, signal);
  signal.throwIfAborted();
  const db = await openMemoryDatabase();
  try {
    db.exec(
      "CREATE VIRTUAL TABLE chunks USING fts5(path UNINDEXED, start_line UNINDEXED, end_line UNINDEXED, text, tokenize='unicode61')",
    );
    const insert = db.prepare("INSERT INTO chunks(path,start_line,end_line,text) VALUES (?,?,?,?)");
    for (const chunk of chunks) {
      signal.throwIfAborted();
      insert.run(chunk.path, chunk.startLine, chunk.endLine, chunk.text);
    }
    const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
    const rows = db
      .prepare(
        "SELECT path,start_line,end_line,text,bm25(chunks) AS rank FROM chunks WHERE chunks MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(expression, Math.max(1, Math.min(MAX_RESULTS, limit))) as Array<{
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      rank: number;
    }>;
    return rows.map((row) => ({
      path: row.path,
      startLine: Number(row.start_line),
      endLine: Number(row.end_line),
      text: row.text,
      score: -row.rank,
    }));
  } finally {
    db.close();
  }
}

async function discoverChunks(root: string, base: string, signal: AbortSignal): Promise<SearchChunk[]> {
  const files: string[] = [];
  let totalBytes = 0;
  async function walk(directory: string, depth = 0): Promise<void> {
    signal.throwIfAborted();
    if (files.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES || depth > 24) return;
    const resolvedDirectory = await realpath(directory);
    const directoryRel = relative(root, resolvedDirectory);
    if (directoryRel === ".." || directoryRel.startsWith(`..${sep}`) || isAbsolute(directoryRel)) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      signal.throwIfAborted();
      if (entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
      const full = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && INCLUDED_EXTENSIONS.has(extname(entry.name).toLowerCase()) && files.length < MAX_FILES)
        files.push(full);
    }
  }
  await walk(base);
  const chunks: SearchChunk[] = [];
  for (const path of files) {
    signal.throwIfAborted();
    const resolvedPath = await realpath(path);
    const resolvedRel = relative(root, resolvedPath);
    if (resolvedRel === ".." || resolvedRel.startsWith(`..${sep}`) || isAbsolute(resolvedRel)) continue;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      continue;
    }
    let bytes: Buffer | undefined;
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_FILE_BYTES || totalBytes + stats.size > MAX_TOTAL_BYTES) continue;
      const checkedPath = await realpath(path);
      const checkedRel = relative(root, checkedPath);
      if (checkedRel === ".." || checkedRel.startsWith(`..${sep}`) || isAbsolute(checkedRel)) continue;
      const parts: Buffer[] = [];
      let size = 0;
      for (;;) {
        signal.throwIfAborted();
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        parts.push(buffer.subarray(0, bytesRead));
        if (size > MAX_FILE_BYTES) break;
      }
      if (size <= MAX_FILE_BYTES) bytes = Buffer.concat(parts, size);
    } finally {
      await handle.close();
    }
    if (!bytes) continue;
    totalBytes += bytes.byteLength;
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    if (text.includes("\ufffd")) continue;
    const lines = text.split(/\r?\n/u);
    let start = 0;
    while (start < lines.length) {
      let end = start;
      let size = 0;
      while (end < lines.length) {
        const next = Buffer.byteLength(lines[end] ?? "", "utf8") + (end > start ? 1 : 0);
        if (end > start && size + next > CHUNK_BYTES) break;
        size += next;
        end++;
      }
      if (end === start) end++;
      const body = lines.slice(start, end).join("\n");
      if (body.trim())
        chunks.push({
          path: relative(root, path).split(sep).join("/"),
          startLine: start + 1,
          endLine: end,
          text: body,
        });
      start = end;
    }
  }
  return chunks;
}

export async function rerankSearchHits(
  hits: readonly SearchHit[],
  query: string,
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchHit[]> {
  if (!hits.length) return [];
  const questions = Object.fromEntries(
    hits.map((hit, index) => [
      `hit_${index}`,
      {
        type: "noul" as const,
        instructions: `Does this exact source excerpt help answer the user's query? Query: ${query}\nFile: ${hit.path}:${hit.startLine}-${hit.endLine}\nExcerpt: ${hit.text.slice(0, 12_000)}`,
      },
    ]),
  );
  const result = await requestJevDecision(
    {
      state: {
        task: "Rank source excerpts for relevance",
        query,
        candidates: hits.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })),
      },
      questions,
    },
    apiKey,
    signal,
    fetchImpl,
  );
  return hits
    .map((hit, index) => {
      const answer = result.answers[`hit_${index}`];
      return { ...hit, semantic: answer?.type === "noul" ? answer.noul : 0 };
    })
    .sort((a, b) => (b.semantic ?? 0) - (a.semantic ?? 0) || b.score - a.score);
}

export async function registerTypesafeSearch(ctx: PluginContext): Promise<void> {
  await ctx.tool.transform((editor) =>
    editor.add({
      name: "typesafe_search",
      description:
        "Search current-project text files with SQLite FTS5 and exact line ranges; semantic reranking is optional and sends candidates to TypeSafe only when explicitly requested.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 1000 },
          path: { type: "string", minLength: 1, maxLength: 4096, description: "Project-relative directory, usually ." },
          limit: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
          semantic_rerank: {
            type: "boolean",
            description: "Explicitly send local lexical candidates to TypeSafe Jev for relevance scoring.",
          },
        },
        required: ["query", "path"],
        additionalProperties: false,
      },
      execute: async (input, execution) => {
        const args = input as { query: string; path: string; limit?: number; semantic_rerank?: boolean };
        if (!args.query.trim() || !args.path.trim())
          throw new Error("query and project-relative path must not be empty");
        const hits = await searchWorkspace(ctx.location.directory, args.path, args.query, execution.signal, args.limit);
        execution.signal.throwIfAborted();
        let output = hits;
        if (args.semantic_rerank) {
          const key = ctx.options.typesafeApiKey;
          if (typeof key !== "string" || !key.trim())
            throw new Error(
              "semantic_rerank requires typesafeApiKey in this plugin's OpenCode config; lexical search remains available without it",
            );
          output = await rerankSearchHits(hits, args.query, key, execution.signal);
        }
        execution.signal.throwIfAborted();
        return { content: boundedJsonContent({ mode: args.semantic_rerank ? "fts5+jev" : "fts5", results: output }) };
      },
    }),
  );
}
