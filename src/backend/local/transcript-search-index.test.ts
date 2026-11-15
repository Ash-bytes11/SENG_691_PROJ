import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT,
  LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
} from "@/backend/local/local-transcript";
import {
  conversationSearchIndexPath,
  indexedSearchMessage,
  loadConversationSearchIndex,
  rebuildLocalSearchIndexes,
} from "@/backend/local/transcript-search-index";

const conversation = { id: "conv-1", agent_id: "agent-1" };
const timestamp = "2025-01-01T00:00:00.000Z";
const header = { type: "session", version: 3, id: "conv-1", timestamp };
const userMessage = {
  id: "m1",
  role: "user",
  content: "orchid migration plan",
  timestamp: 1,
};
const searchCall = {
  id: "m2",
  role: "assistant",
  content: [
    { type: "text", text: "checking history" },
    {
      type: "toolCall",
      id: "call-1",
      name: "Bash",
      arguments: { command: "letta messages search orchid" },
    },
  ],
  timestamp: 2,
};
const searchResult = {
  id: "m3",
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "Bash",
  content: [{ type: "text", text: "orchid orchid" }],
  isError: false,
  timestamp: 3,
};
const sessionRows = [
  header,
  { type: "message", timestamp, message: userMessage },
  { type: "message", timestamp, message: searchCall },
  { type: "message", timestamp, message: searchResult },
];
const appended = { id: "m4", role: "user", content: "needle", timestamp: 4 };
const appendedEntry = { type: "message", timestamp, message: appended };
const appendedLine = `${JSON.stringify(appendedEntry)}\n`;

let storageDir: string;
let dir: string;
let messagesPath: string;

beforeEach(() => {
  storageDir = mkdtempSync(join(tmpdir(), "local-search-index-"));
  dir = join(storageDir, "conversations", conversation.id);
  messagesPath = join(dir, "messages.jsonl");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "conversation.json"), JSON.stringify(conversation));
  writeTranscript(LOCAL_TRANSCRIPT_MESSAGE_FORMAT, sessionRows);
});

afterEach(() => {
  rmSync(storageDir, { recursive: true, force: true });
});

function writeTranscript(format: string, rows: unknown[]) {
  const manifest = { message_format: format };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  const lines = rows.map((row) => `${JSON.stringify(row)}\n`);
  writeFileSync(messagesPath, lines.join(""));
}

function loadIndex() {
  const loaded = loadConversationSearchIndex(dir, conversation);
  if (!loaded) {
    throw new Error("expected a search index");
  }
  return loaded;
}

describe("local transcript search index", () => {
  test("indexes each searchable message, then reuses the stored index", () => {
    const { index, refresh } = loadIndex();
    expect(refresh).toBe("rebuilt");
    expect(index.texts).toEqual([
      "user message orchid migration plan",
      "assistant message checking history",
      "approval request message bash command letta messages search orchid",
      "tool return message orchid orchid",
    ]);
    expect(index.searchToolCallIds).toEqual(["call-1"]);
    expect(index.echoKeys).toEqual([null, null, "call-1", "call-1"]);
    // The assistant line projects to two messages: its text and its tool call.
    expect(indexedSearchMessage(dir, index, 1)?.id).toBe("m2");
    const toolRequest = indexedSearchMessage(dir, index, 2);
    expect(toolRequest?.id).toBe("m2:tool:call-1:request");
    expect(loadIndex()).toEqual({ index, refresh: "fresh" });
  });

  test("indexes legacy-format transcripts", () => {
    writeTranscript(LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT, [userMessage]);
    const { index } = loadIndex();
    expect(index.texts).toEqual(["user message orchid migration plan"]);
    expect(indexedSearchMessage(dir, index, 0)?.id).toBe("m1");
  });

  test("makes an appended message searchable without a rebuild", () => {
    loadIndex();
    appendFileSync(messagesPath, appendedLine);
    const { index, refresh } = loadIndex();
    expect(refresh).toBe("appended");
    expect(index.texts[4]).toBe("user message needle");
    expect(indexedSearchMessage(dir, index, 4)?.id).toBe("m4");
  });

  test("waits for a partially written last line", () => {
    loadIndex();
    appendFileSync(messagesPath, appendedLine.slice(0, 40));
    expect(loadIndex().index.texts).toHaveLength(4);
    appendFileSync(messagesPath, appendedLine.slice(40));
    expect(loadIndex().refresh).toBe("appended");
  });

  test("rebuilds after a rewrite and skips unreadable transcripts", () => {
    loadIndex();
    const original = readFileSync(messagesPath, "utf8");
    const edited = original.replace("migration plan", "rollout plan");
    writeFileSync(messagesPath, edited + appendedLine);
    const { index, refresh } = loadIndex();
    expect(refresh).toBe("rebuilt");
    expect(index.texts[0]).toBe("user message orchid rollout plan");

    appendFileSync(messagesPath, "{broken\n");
    expect(loadConversationSearchIndex(dir, conversation)).toBeUndefined();
  });

  test("rebuilds corrupt or outdated index files", () => {
    const { index } = loadIndex();
    const indexPath = conversationSearchIndexPath(dir);
    const outdated = JSON.stringify({ ...index, version: 0 });
    for (const contents of ["{not json", outdated]) {
      writeFileSync(indexPath, contents);
      expect(loadIndex().refresh).toBe("rebuilt");
    }
    expect(rebuildLocalSearchIndexes(storageDir)).toBe(1);
  });
});
