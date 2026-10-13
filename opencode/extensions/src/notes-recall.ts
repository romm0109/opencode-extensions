import { randomUUID } from "node:crypto";
import type { Plugin } from "@opencode/plugin";

/**
 * Bounded local data services for the notes and recall ports.
 *
 * OpenCode's server plugin storage is the persistence boundary here. These helpers
 * deliberately accept no filesystem path and never invoke a model or external API.
 */
export interface KeyValueStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface RecallRecord {
  id: string;
  role: "user" | "assistant";
  text: string;
  sourceSessionID: string;
  sourceMessageID: string;
  cwd?: string;
  sessionName?: string;
  timestamp: number;
  savedAt: number;
}

export interface RecallCandidate extends Omit<RecallRecord, "id" | "savedAt"> {
  id?: string;
}

const NOTES_KEY = "data/notes";
const RECALL_KEY = "data/recall";
export const MAX_NOTES = 500;
export const MAX_NOTE_BYTES = 48_000;
export const MAX_RECALL_RECORDS = 200;
export const MAX_RECALL_TEXT_BYTES = 50_000;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) return undefined;
  return value;
}

function validNote(value: unknown): value is Note {
  const row = asObject(value);
  return (
    !!row &&
    typeof row.id === "string" &&
    !!row.id &&
    typeof row.title === "string" &&
    typeof row.body === "string" &&
    Buffer.byteLength(row.body, "utf8") <= MAX_NOTE_BYTES &&
    Number.isSafeInteger(row.createdAt) &&
    Number.isSafeInteger(row.updatedAt)
  );
}

function validRecall(value: unknown): value is RecallRecord {
  const row = asObject(value);
  return (
    !!row &&
    typeof row.id === "string" &&
    !!row.id &&
    (row.role === "user" || row.role === "assistant") &&
    typeof row.text === "string" &&
    row.text.trim().length > 0 &&
    Buffer.byteLength(row.text, "utf8") <= MAX_RECALL_TEXT_BYTES &&
    typeof row.sourceSessionID === "string" &&
    !!row.sourceSessionID &&
    typeof row.sourceMessageID === "string" &&
    !!row.sourceMessageID &&
    Number.isSafeInteger(row.timestamp) &&
    Number.isSafeInteger(row.savedAt)
  );
}

function readNotes(value: unknown): Note[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_NOTES || !value.every(validNote)) {
    throw new Error("Notes data is malformed or exceeds its supported limit; it was left unchanged.");
  }
  const ids = new Set<string>();
  for (const note of value) {
    if (ids.has(note.id)) throw new Error("Notes data contains duplicate IDs; it was left unchanged.");
    ids.add(note.id);
  }
  return value;
}

function readRecall(value: unknown): RecallRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RECALL_RECORDS || !value.every(validRecall)) {
    throw new Error("Recall data is malformed or exceeds its supported limit; it was left unchanged.");
  }
  const ids = new Set<string>();
  const sources = new Set<string>();
  for (const record of value) {
    const source = `${record.sourceSessionID}\u0000${record.sourceMessageID}`;
    if (ids.has(record.id) || sources.has(source)) {
      throw new Error("Recall data contains duplicate records; it was left unchanged.");
    }
    ids.add(record.id);
    sources.add(source);
  }
  return value;
}

/** CRUD for user-authored notes in the plugin's private durable storage. */
export function createNotesService(
  storage: KeyValueStorage,
  options: {
    now?: () => number;
    createID?: () => string;
  } = {},
) {
  const now = options.now ?? Date.now;
  const createID = options.createID ?? randomUUID;
  let mutationQueue = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>) => {
    const pending = mutationQueue.catch(() => undefined).then(work);
    mutationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };

  return {
    async list(): Promise<Note[]> {
      return [...readNotes(await storage.get(NOTES_KEY))].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async get(id: string): Promise<Note | undefined> {
      return readNotes(await storage.get(NOTES_KEY)).find((note) => note.id === id);
    },
    async create(title: string, body = ""): Promise<Note> {
      if (!title.trim() || title.length > 200 || boundedText(body, MAX_NOTE_BYTES) === undefined) {
        throw new Error("A note needs a title (up to 200 characters) and a body within the supported size limit.");
      }
      return serialize(async () => {
        const notes = readNotes(await storage.get(NOTES_KEY));
        if (notes.length >= MAX_NOTES) throw new Error(`Notes are limited to ${MAX_NOTES} entries.`);
        const timestamp = now();
        const note = { id: createID(), title: title.trim(), body, createdAt: timestamp, updatedAt: timestamp };
        if (notes.some((item) => item.id === note.id))
          throw new Error("The note ID generator returned a duplicate ID.");
        await storage.set(NOTES_KEY, [...notes, note]);
        return note;
      });
    },
    async update(id: string, change: { title?: string; body?: string }): Promise<Note> {
      return serialize(async () => {
        const notes = readNotes(await storage.get(NOTES_KEY));
        const index = notes.findIndex((note) => note.id === id);
        if (index < 0) throw new Error("Note not found.");
        const current = notes[index];
        const title = change.title === undefined ? current.title : change.title.trim();
        const body = change.body === undefined ? current.body : change.body;
        if (!title || title.length > 200 || boundedText(body, MAX_NOTE_BYTES) === undefined) {
          throw new Error("A note needs a title (up to 200 characters) and a body within the supported size limit.");
        }
        const updated = { ...current, title, body, updatedAt: now() };
        notes[index] = updated;
        await storage.set(NOTES_KEY, notes);
        return updated;
      });
    },
    async delete(id: string): Promise<boolean> {
      return serialize(async () => {
        const notes = readNotes(await storage.get(NOTES_KEY));
        const next = notes.filter((note) => note.id !== id);
        if (next.length === notes.length) return false;
        await storage.set(NOTES_KEY, next);
        return true;
      });
    },
  };
}

/**
 * Local save/search/quote operations. Explicit message IDs and text are required:
 * the v2 server API does not expose a public editor insertion or message picker.
 */
export function createRecallService(
  storage: KeyValueStorage,
  options: {
    now?: () => number;
    createID?: () => string;
  } = {},
) {
  const now = options.now ?? Date.now;
  const createID = options.createID ?? randomUUID;
  let mutationQueue = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>) => {
    const pending = mutationQueue.catch(() => undefined).then(work);
    mutationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
  return {
    async list(
      filter: { sessionID?: string; cwd?: string; role?: RecallRecord["role"]; query?: string } = {},
    ): Promise<RecallRecord[]> {
      const query = filter.query?.toLocaleLowerCase();
      return readRecall(await storage.get(RECALL_KEY))
        .filter((record) => !filter.sessionID || record.sourceSessionID === filter.sessionID)
        .filter((record) => !filter.cwd || record.cwd === filter.cwd)
        .filter((record) => !filter.role || record.role === filter.role)
        .filter(
          (record) =>
            !query || `${record.text} ${record.role} ${record.sessionName ?? ""}`.toLocaleLowerCase().includes(query),
        )
        .sort((a, b) => b.savedAt - a.savedAt);
    },
    async save(candidate: RecallCandidate): Promise<RecallRecord> {
      if (
        (candidate.role !== "user" && candidate.role !== "assistant") ||
        !candidate.text.trim() ||
        boundedText(candidate.text, MAX_RECALL_TEXT_BYTES) === undefined ||
        !candidate.sourceSessionID ||
        !candidate.sourceMessageID ||
        !Number.isSafeInteger(candidate.timestamp)
      ) {
        throw new Error("Recall requires a non-empty user or assistant text message with source IDs and timestamp.");
      }
      return serialize(async () => {
        const records = readRecall(await storage.get(RECALL_KEY));
        if (
          records.some(
            (record) =>
              record.sourceSessionID === candidate.sourceSessionID &&
              record.sourceMessageID === candidate.sourceMessageID,
          )
        ) {
          throw new Error("That message has already been saved.");
        }
        if (records.length >= MAX_RECALL_RECORDS)
          throw new Error(`Recall is limited to ${MAX_RECALL_RECORDS} saved messages.`);
        const record = { ...candidate, id: candidate.id ?? createID(), savedAt: now() };
        if (records.some((item) => item.id === record.id))
          throw new Error("The recall ID generator returned a duplicate ID.");
        await storage.set(RECALL_KEY, [...records, record]);
        return record;
      });
    },
    async delete(id: string): Promise<boolean> {
      return serialize(async () => {
        const records = readRecall(await storage.get(RECALL_KEY));
        const next = records.filter((record) => record.id !== id);
        if (next.length === records.length) return false;
        await storage.set(RECALL_KEY, next);
        return true;
      });
    },
    quote(record: RecallRecord): string {
      if (!validRecall(record)) throw new Error("Cannot quote an invalid recall record.");
      return `<recalled_message role="${record.role}" message_timestamp="${new Date(record.timestamp).toISOString()}">\n${record.text}\n</recalled_message>\n\nThe user intentionally recalled and quoted the saved message above.`;
    },
  };
}

type NotesRecallContext = Pick<Plugin.Context, "tool" | "command" | "session" | "storage">;

function asStorage(storage: Plugin.Context["storage"]): KeyValueStorage {
  return {
    get: async (key) => storage.get(key),
    set: async (key, value) => storage.set(key, value as never),
    remove: async (key) => storage.remove(key),
  };
}

function toolResult(value: unknown) {
  return { content: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return { type: "object" as const, properties, required, additionalProperties: false as const };
}

const stringField = (description: string) => ({ type: "string" as const, description });

/** Register user-facing commands and structured tools for notes and saved-message recall. */
export async function registerNotesRecall(ctx: NotesRecallContext): Promise<void> {
  const storage = asStorage(ctx.storage);
  const notes = createNotesService(storage);
  const recall = createRecallService(storage);

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "notes_list",
      options: { codemode: false },
      description: "List locally stored Markdown-style notes.",
      input: objectSchema({}, []),
      execute: async () => toolResult(await notes.list()),
    });
    editor.add({
      name: "notes_create",
      options: { codemode: false },
      description: "Create a local note with a title and optional body.",
      input: objectSchema({ title: stringField("Note title"), body: stringField("Note body") }, ["title"]),
      execute: async (input) => {
        const value = input as { title: string; body?: string };
        return toolResult(await notes.create(value.title, value.body ?? ""));
      },
    });
    editor.add({
      name: "notes_read",
      options: { codemode: false },
      description: "Read a locally stored note by ID.",
      input: objectSchema({ id: stringField("Note ID") }, ["id"]),
      execute: async (input) => {
        const note = await notes.get((input as { id: string }).id);
        return toolResult(note ?? "Note not found.");
      },
    });
    editor.add({
      name: "notes_update",
      options: { codemode: false },
      description: "Update the title and/or body of a local note by ID.",
      input: objectSchema(
        {
          id: stringField("Note ID"),
          title: stringField("Replacement title"),
          body: stringField("Replacement body"),
        },
        ["id"],
      ),
      execute: async (input) => {
        const value = input as { id: string; title?: string; body?: string };
        return toolResult(await notes.update(value.id, { title: value.title, body: value.body }));
      },
    });
    editor.add({
      name: "notes_delete",
      options: { codemode: false },
      description: "Delete a local note by ID. Use only when the user requested deletion.",
      input: objectSchema({ id: stringField("Note ID") }, ["id"]),
      execute: async (input) =>
        toolResult((await notes.delete((input as { id: string }).id)) ? "Note deleted." : "Note not found."),
    });
    editor.add({
      name: "recall_save",
      options: { codemode: false },
      description:
        "Save a user- or assistant-text message for later recall. Supply the message source ID and timestamp.",
      input: objectSchema(
        {
          role: { type: "string" as const, enum: ["user", "assistant"] },
          text: stringField("Full message text"),
          sourceMessageID: stringField("OpenCode message ID"),
          timestamp: { type: "integer" as const, description: "Message timestamp in Unix milliseconds" },
          cwd: stringField("Optional source working directory"),
          sessionName: stringField("Optional source session name"),
        },
        ["role", "text", "sourceMessageID", "timestamp"],
      ),
      execute: async (input, execution) => {
        const value = input as Omit<RecallCandidate, "sourceSessionID"> & { sourceMessageID: string };
        const record = await recall.save({ ...value, sourceSessionID: execution.sessionID });
        return toolResult({ saved: true, id: record.id, role: record.role, timestamp: record.timestamp });
      },
    });
    editor.add({
      name: "recall_search",
      options: { codemode: false },
      description: "Search saved messages. Filters may be combined.",
      input: objectSchema(
        {
          query: stringField("Text search"),
          sessionID: stringField("Restrict to a source session ID"),
          cwd: stringField("Restrict to a source working directory"),
          role: { type: "string" as const, enum: ["user", "assistant"] },
        },
        [],
      ),
      execute: async (input) => toolResult(await recall.list(input as Parameters<typeof recall.list>[0])),
    });
    editor.add({
      name: "recall_quote",
      options: { codemode: false },
      description: "Render a saved message as an XML-marked quote. This does not insert text into the prompt editor.",
      input: objectSchema({ id: stringField("Saved recall ID") }, ["id"]),
      execute: async (input) => {
        const record = (await recall.list()).find((item) => item.id === (input as { id: string }).id);
        return toolResult(record ? recall.quote(record) : "Saved message not found.");
      },
    });
    editor.add({
      name: "recall_delete",
      options: { codemode: false },
      description: "Delete a saved message by ID. Use only when the user requested deletion.",
      input: objectSchema({ id: stringField("Saved recall ID") }, ["id"]),
      execute: async (input) =>
        toolResult(
          (await recall.delete((input as { id: string }).id)) ? "Saved message deleted." : "Saved message not found.",
        ),
    });
  });

  await ctx.command.transform((editor) => {
    editor.add({
      name: "notes",
      description: "List local notes; use the notes_* tools for structured note operations.",
      execute: async ({ sessionID, prompt }) => {
        const argument = prompt.text.trim().replace(/^\/notes\s*/i, "");
        if (!argument || argument === "list") {
          const list = await notes.list();
          const view = list.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
          await ctx.session.synthetic({
            sessionID,
            text: view.length ? JSON.stringify(view, null, 2) : "No notes saved.",
            resume: false,
          });
          return;
        }
        await ctx.session.synthetic({
          sessionID,
          text: "Use notes_create, notes_read, notes_update, or notes_delete for structured note operations.",
          resume: false,
        });
      },
    });
    editor.add({
      name: "recall",
      description: "Search saved messages; use recall_* tools to save, quote, or delete records.",
      execute: async ({ sessionID, prompt }) => {
        const argument = prompt.text.trim().replace(/^\/recall\s*/i, "");
        const query = argument.replace(/^search\s*/i, "");
        const matches = await recall.list({ query });
        await ctx.session.synthetic({
          sessionID,
          text: matches.length ? JSON.stringify(matches, null, 2) : "No saved messages matched.",
          resume: false,
        });
      },
    });
  });
}
