import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "@/utils/type-guards";
import type {
  LocalTranscriptManifest,
  LocalTranscriptMessageFormat,
} from "./local-transcript";
import type { StoredMessage } from "./local-types";
import {
  type ConversationMessagesInput,
  conversationDirectories,
  conversationSearchRecord,
  dateInRange,
  type LocalConversationSearchRecord,
  normalizeText,
  projectedTranscriptMessages,
  readJsonFile,
  type SearchableStoredMessage,
  searchableText,
  searchEchoKey,
  searchToolCallId,
  transcriptFormat,
  transcriptMessageRow,
} from "./transcript-search";

export const LOCAL_SEARCH_INDEX_VERSION = 1;
// A rewrite that does not change the length to earlier lines are not detected
const TAIL_CHECK_BYTES = 64;

export type ConversationSearchIndex = {
  version: number;
  agentId: string;
  conversationId: string;
  format: LocalTranscriptMessageFormat;
  size: number;
  mtimeMs: number;
  indexedBytes: number;
  tailHex: string;
  rowCount: number;
  searchToolCallIds: string[];
  locations: number[];
  dates: string[];
  messageTypes: string[];
  conversationIds: string[];
  echoKeys: (string | null)[];
  texts: string[];
};

export type SearchIndexRefresh = "fresh" | "appended" | "rebuilt";

export type LoadedSearchIndex = {
  index: ConversationSearchIndex;
  refresh: SearchIndexRefresh;
};

type ParsedLine = { row: unknown; start: number; end: number };
type ParsedLines = { lines: ParsedLine[]; consumed: number };
type CatchUpStatus = "fresh" | "appended" | "stale" | "unreadable";

export function conversationSearchIndexPath(conversationDir: string): string {
  return join(conversationDir, "search-index.json");
}

function readBytes(path: string, start: number, end: number): Buffer {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  const fd = openSync(path, "r");
  try {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function parseJson(text: string): { row: unknown } | undefined {
  try {
    return { row: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

function parseLines(buffer: Buffer, offset: number): ParsedLines | undefined {
  const lines: ParsedLine[] = [];
  let position = 0;
  while (position < buffer.length) {
    const newline = buffer.indexOf(0x0a, position);
    const isLastLine = newline === -1;
    const end = isLastLine ? buffer.length : newline;
    const text = buffer.toString("utf8", position, end);
    if (text.trim().length > 0) {
      const parsed = parseJson(text);
      if (!parsed && isLastLine) {
        break;
      }
      if (!parsed) {
        return undefined;
      }
      const start = offset + position;
      lines.push({ row: parsed.row, start, end: offset + end });
    }
    position = isLastLine ? buffer.length : newline + 1;
  }
  return { lines, consumed: offset + position };
}

function projectRow(
  index: ConversationSearchIndex,
  value: unknown,
  rowIndex: number,
): StoredMessage[] {
  const row = transcriptMessageRow(value, rowIndex, index.format);
  if (!row) {
    return [];
  }
  const { agentId, conversationId } = index;
  return projectedTranscriptMessages({ row, agentId, conversationId });
}

function ingestLines(index: ConversationSearchIndex, lines: ParsedLine[]) {
  const searchToolCallIds = new Set(index.searchToolCallIds);
  for (const line of lines) {
    const rowIndex = index.rowCount++;
    const messages = projectRow(index, line.row, rowIndex);
    for (const [projectedIndex, message] of messages.entries()) {
      const toolCallId = searchToolCallId(message);
      if (toolCallId !== undefined) {
        searchToolCallIds.add(toolCallId);
      }
      const text = normalizeText(searchableText(message));
      if (!text) {
        continue;
      }
      index.locations.push(line.start, line.end, rowIndex, projectedIndex);
      index.dates.push(message.date);
      index.messageTypes.push(message.message_type);
      index.conversationIds.push(message.conversation_id ?? "");
      index.echoKeys.push(searchEchoKey(message) ?? null);
      index.texts.push(text);
    }
  }
  index.searchToolCallIds = [...searchToolCallIds];
}

function tailHex(buffer: Buffer, end: number): string {
  const start = Math.max(0, end - TAIL_CHECK_BYTES);
  return buffer.subarray(start, end).toString("hex");
}

function buildIndex(
  messagesPath: string,
  conversation: LocalConversationSearchRecord,
  manifest: LocalTranscriptManifest | undefined,
): ConversationSearchIndex | undefined {
  // Stat before reading so a write landing in between changes mtime and the
  // next load re-checks the file.
  const { mtimeMs } = statSync(messagesPath);
  const buffer = readFileSync(messagesPath);
  const parsed = parseLines(buffer, 0);
  if (!parsed || parsed.lines.length === 0) {
    return undefined;
  }
  const rows = parsed.lines.map((line) => line.row);
  const format = transcriptFormat(manifest, rows);
  if (!format) {
    return undefined;
  }
  const index: ConversationSearchIndex = {
    version: LOCAL_SEARCH_INDEX_VERSION,
    agentId: conversation.agent_id,
    conversationId: conversation.id,
    format,
    size: buffer.length,
    mtimeMs,
    indexedBytes: parsed.consumed,
    tailHex: tailHex(buffer, parsed.consumed),
    rowCount: 0,
    searchToolCallIds: [],
    locations: [],
    dates: [],
    messageTypes: [],
    conversationIds: [],
    echoKeys: [],
    texts: [],
  };
  ingestLines(index, parsed.lines);
  return index;
}

function catchUp(path: string, index: ConversationSearchIndex): CatchUpStatus {
  const { size, mtimeMs } = statSync(path);
  const unchanged = size === index.size && mtimeMs === index.mtimeMs;
  if (unchanged) {
    return "fresh";
  }
  const truncated = size < index.indexedBytes;
  if (truncated) {
    return "stale";
  }
  const checkStart = Math.max(0, index.indexedBytes - TAIL_CHECK_BYTES);
  const buffer = readBytes(path, checkStart, size);
  const checkLength = index.indexedBytes - checkStart;
  const rewritten = tailHex(buffer, checkLength) !== index.tailHex;
  if (rewritten) {
    return "stale";
  }
  const appended = buffer.subarray(checkLength);
  const parsed = parseLines(appended, index.indexedBytes);
  if (!parsed) {
    return "unreadable";
  }
  ingestLines(index, parsed.lines);
  index.size = checkStart + buffer.length;
  index.mtimeMs = mtimeMs;
  index.indexedBytes = parsed.consumed;
  index.tailHex = tailHex(buffer, parsed.consumed - checkStart);
  return parsed.lines.length > 0 ? "appended" : "fresh";
}

function readStoredIndex(
  conversationDir: string,
  conversation: LocalConversationSearchRecord,
  manifest: LocalTranscriptManifest | undefined,
): ConversationSearchIndex | undefined {
  const path = conversationSearchIndexPath(conversationDir);
  const value = readJsonFile<unknown>(path);
  if (!isRecord(value)) {
    return undefined;
  }
  const isCurrentVersion = value.version === LOCAL_SEARCH_INDEX_VERSION;
  const sameAgent = value.agentId === conversation.agent_id;
  const sameConversation = value.conversationId === conversation.id;
  const manifestFormat = transcriptFormat(manifest, []);
  const sameFormat = !manifestFormat || manifestFormat === value.format;
  const hasSearchIds = Array.isArray(value.searchToolCallIds);
  const count = Array.isArray(value.texts) ? value.texts.length : -1;
  const locations = Array.isArray(value.locations) ? value.locations : [];
  const locationsMatch = locations.length === count * 4;
  const columns = [
    value.dates,
    value.messageTypes,
    value.conversationIds,
    value.echoKeys,
  ];
  const columnsMatch = columns.every(
    (column) => Array.isArray(column) && column.length === count,
  );
  const usable =
    isCurrentVersion &&
    sameAgent &&
    sameConversation &&
    sameFormat &&
    hasSearchIds &&
    locationsMatch &&
    columnsMatch;
  if (!usable) {
    return undefined;
  }
  return value as unknown as ConversationSearchIndex;
}

function writeIndex(conversationDir: string, index: ConversationSearchIndex) {
  const path = conversationSearchIndexPath(conversationDir);
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(index));
    renameSync(temporary, path);
  } catch {
    rmSync(temporary, { force: true });
  }
}

// Undefined whenever the scan would find nothing in this conversation.
export function loadConversationSearchIndex(
  conversationDir: string,
  conversation: LocalConversationSearchRecord,
): LoadedSearchIndex | undefined {
  const messagesPath = join(conversationDir, "messages.jsonl");
  if (!existsSync(messagesPath)) {
    return undefined;
  }
  const manifestPath = join(conversationDir, "manifest.json");
  const manifest = readJsonFile<LocalTranscriptManifest>(manifestPath);
  const stored = readStoredIndex(conversationDir, conversation, manifest);
  if (stored) {
    const { size, mtimeMs } = stored;
    const status = catchUp(messagesPath, stored);
    if (status === "unreadable") {
      return undefined;
    }
    if (status !== "stale") {
      const changed = stored.size !== size || stored.mtimeMs !== mtimeMs;
      if (changed) {
        writeIndex(conversationDir, stored);
      }
      return { index: stored, refresh: status };
    }
  }
  const index = buildIndex(messagesPath, conversation, manifest);
  if (!index) {
    return undefined;
  }
  writeIndex(conversationDir, index);
  return { index, refresh: "rebuilt" };
}

export function rebuildLocalSearchIndexes(storageDir: string): number {
  let rebuilt = 0;
  for (const conversationDir of conversationDirectories(storageDir)) {
    const recordPath = join(conversationDir, "conversation.json");
    const conversation = conversationSearchRecord(readJsonFile(recordPath));
    if (!conversation) {
      continue;
    }
    rmSync(conversationSearchIndexPath(conversationDir), { force: true });
    const loaded = loadConversationSearchIndex(conversationDir, conversation);
    if (loaded) {
      rebuilt++;
    }
  }
  return rebuilt;
}

export function indexedSearchMessage(
  conversationDir: string,
  index: ConversationSearchIndex,
  document: number,
): StoredMessage | undefined {
  const location = index.locations.slice(document * 4, document * 4 + 4);
  const [start = 0, end = 0, rowIndex = 0, projectedIndex] = location;
  if (projectedIndex === undefined) {
    return undefined;
  }
  const messagesPath = join(conversationDir, "messages.jsonl");
  const line = readBytes(messagesPath, start, end).toString("utf8");
  const parsed = parseJson(line);
  if (!parsed) {
    return undefined;
  }
  return projectRow(index, parsed.row, rowIndex)[projectedIndex];
}

// The scan's searchable records for one conversation, built from its index
// instead of re-reading and re-tokenizing the transcript.
export function indexedConversationMessages(
  input: ConversationMessagesInput,
): SearchableStoredMessage[] {
  const { conversation, conversationDir } = input;
  const otherAgent = input.agentId && conversation.agent_id !== input.agentId;
  const otherConversation =
    input.conversationId && conversation.id !== input.conversationId;
  if (otherAgent || otherConversation) {
    return [];
  }
  const loaded = loadConversationSearchIndex(conversationDir, conversation);
  if (!loaded) {
    return [];
  }
  const { index } = loaded;
  // Holds only strings, so a null echo key never matches.
  const searchIds = new Set<unknown>(index.searchToolCallIds);
  const records: SearchableStoredMessage[] = [];
  for (const [document, text] of index.texts.entries()) {
    const date = index.dates[document] ?? "";
    if (!dateInRange(date, input.startDate, input.endDate)) {
      continue;
    }
    const message_type = index.messageTypes[document];
    const conversation_id = index.conversationIds[document];
    const message = { date, message_type, conversation_id } as StoredMessage;
    const resolve = () => {
      const full = indexedSearchMessage(conversationDir, index, document);
      if (!full) {
        throw new Error(`Search index for ${conversationDir} is out of date`);
      }
      return full;
    };
    records.push({
      message,
      normalizedText: text,
      tokens: text.split(" "),
      score: 0,
      isSearchEcho: searchIds.has(index.echoKeys[document]),
      resolve,
    });
  }
  return records;
}
