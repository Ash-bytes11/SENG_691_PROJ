/**
 * Structured fact preservation for adaptive context compaction.
 *
 * A model written summary can paraphrase or drop exact identifiers. Before a
 * summary replaces older messages, this module pulls the details a coding
 * task depends on out of those messages with deterministic rules, so
 * retention does not depend on the summarizer model. The facts are appended
 * to the summary verbatim as a "Preserved facts" block.
 *
 * The block written by an earlier compaction is parsed back out of the
 * evicted summary and merged, so facts survive repeated compactions.
 */
import type { LocalMessage } from "./local-message";

export const PRESERVED_FACTS_HEADER = "## Preserved facts";
export const DEFAULT_FACTS_BLOCK_MAX_CHARS = 2_400;

export interface CompactionFacts {
  files: string[];
  commands: string[];
  errors: string[];
  requirements: string[];
  decisions: string[];
  openTasks: string[];
}

export type CompactionFactKind = keyof CompactionFacts;
export type CompactionFactCounts = Record<CompactionFactKind, number>;

const FACT_KINDS: CompactionFactKind[] = [
  "requirements",
  "decisions",
  "openTasks",
  "errors",
  "commands",
  "files",
];

const SECTION_LABELS: Record<CompactionFactKind, string> = {
  files: "Files",
  commands: "Commands",
  errors: "Errors",
  requirements: "User requirements",
  decisions: "Decisions",
  openTasks: "Open tasks",
};

const MAX_FACT_CHARS = 200;
const MAX_SCAN_CHARS = 20_000;

const FILE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|py|go|rs|java|kt|rb|php|c|h|cpp|hpp|cs|swift|yml|yaml|toml|ini|env|sh|bash|ps1|css|scss|html|sql|txt|lock|xml|csv|ipynb";
const FILE_PATH_PATTERN = new RegExp(
  `(?:^|[\\s"'\`(\\[=:,])((?:~|\\.{1,2})?(?:/?[\\w@.+-]+/)*[\\w@+-][\\w@.+-]*\\.(?:${FILE_EXTENSIONS}))(?=$|[\\s"'\`)\\],:;!?]|\\.(?:\\s|$))`,
  "gim",
);
const COMMAND_TOOL_PATTERN = /bash|shell|command|exec|terminal|run/i;
const PLAN_TOOL_PATTERN = /plan|todo|task/i;
const REQUIREMENT_PATTERN =
  /\b(?:must|should|needs?|never|always|don'?t|do not)\b/i;
const DECISION_PATTERN =
  /^(?:yes|yep|yeah|ok(?:ay)?|sure|approved?|confirm(?:ed)?|agreed|go ahead|sounds good|let'?s (?:go with|use|do|keep)|go with|we(?:'ll| will) (?:go with|use)|use .+ instead)\b/i;
const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

export function emptyCompactionFacts(): CompactionFacts {
  return {
    files: [],
    commands: [],
    errors: [],
    requirements: [],
    decisions: [],
    openTasks: [],
  };
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_FACT_CHARS
    ? `${collapsed.slice(0, MAX_FACT_CHARS - 1)}…`
    : collapsed;
}

/** Lists are kept oldest first; re-adding a fact moves it to the newest end. */
function add(
  facts: CompactionFacts,
  kind: CompactionFactKind,
  value: string,
): void {
  const fact = oneLine(value);
  if (!fact) return;
  const list = facts[kind];
  const existing = list.indexOf(fact);
  if (existing !== -1) list.splice(existing, 1);
  list.push(fact);
}

function addFilePaths(facts: CompactionFacts, text: string): void {
  for (const match of text
    .slice(0, MAX_SCAN_CHARS)
    .matchAll(FILE_PATH_PATTERN)) {
    const path = match[1];
    if (!path || /^\d+(\.\d+)+$/.test(path) || path.includes("://")) continue;
    add(facts, "files", path);
  }
}

function userText(message: LocalMessage & { role: "user" }): string {
  const { content } = message;
  const text =
    typeof content === "string"
      ? content
      : content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n");
  return text.replace(SYSTEM_REMINDER_PATTERN, "").trim();
}

function addUserFacts(facts: CompactionFacts, text: string): void {
  const lines = text.slice(0, MAX_SCAN_CHARS).split(/\n+|(?<=[.!?])\s+/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (DECISION_PATTERN.test(line)) add(facts, "decisions", line);
    else if (REQUIREMENT_PATTERN.test(line)) add(facts, "requirements", line);
  }
  addFilePaths(facts, text);
}

function stringArgument(args: unknown, keys: string[]): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  for (const key of keys) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** Unfinished items from an update_plan or todo style tool call. */
function unfinishedPlanItems(args: unknown): string[] | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  const items = record.plan ?? record.todos ?? record.tasks;
  if (!Array.isArray(items)) return undefined;
  const open: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const text = entry.step ?? entry.content ?? entry.text ?? entry.task;
    if (typeof text !== "string") continue;
    const status = String(entry.status ?? "");
    if (/^(completed|done|cancell?ed)$/i.test(status)) continue;
    open.push(text);
  }
  return open;
}

const ERROR_LINE_PATTERN =
  /\b(?:\w*Error|Exception|Traceback|E\d{3,}|fatal|failed|failure)\b/i;
const MAX_ERROR_PART_CHARS = 90;

function clip(text: string): string {
  return text.length > MAX_ERROR_PART_CHARS
    ? `${text.slice(0, MAX_ERROR_PART_CHARS - 1)}…`
    : text;
}

/** First meaningful line (the error line when one is recognizable) and last line. */
function errorFact(message: LocalMessage & { role: "toolResult" }): string {
  const lines = message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const first =
    lines.find((line) => ERROR_LINE_PATTERN.test(line)) ?? lines[0] ?? "failed";
  const last = lines.at(-1);
  const detail =
    last && last !== first ? `${clip(first)} … ${clip(last)}` : clip(first);
  return `${message.toolName}: ${detail}`;
}

/** Parses the facts block written by an earlier compaction back out. */
export function parseCompactionFactsBlock(text: string): CompactionFacts {
  const facts = emptyCompactionFacts();
  const start = text.indexOf(PRESERVED_FACTS_HEADER);
  if (start === -1) return facts;
  const labelToKind = new Map(
    FACT_KINDS.map((kind) => [`${SECTION_LABELS[kind]}:`, kind]),
  );
  let current: CompactionFactKind | undefined;
  const parsed = emptyCompactionFacts();
  for (const rawLine of text.slice(start).split("\n").slice(1)) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) break;
    const kind = labelToKind.get(line);
    if (kind) {
      current = kind;
      continue;
    }
    if (current && line.startsWith("- ")) {
      parsed[current].push(line.slice(2).replace(/^`|`$/g, ""));
    }
  }
  // The block lists newest first; lists in memory are oldest first.
  for (const kind of FACT_KINDS) {
    for (const fact of parsed[kind].reverse()) add(facts, kind, fact);
  }
  return facts;
}

export function extractCompactionFacts(
  messages: LocalMessage[],
): CompactionFacts {
  const facts = emptyCompactionFacts();
  let latestPlan: string[] | undefined;

  for (const message of messages) {
    const previousSummary = message.metadata?.compaction?.summary;
    if (typeof previousSummary === "string") {
      const carried = parseCompactionFactsBlock(previousSummary);
      for (const kind of FACT_KINDS) {
        for (const fact of carried[kind]) add(facts, kind, fact);
      }
      if (carried.openTasks.length > 0) latestPlan = undefined;
      continue;
    }

    if (message.role === "user") {
      const text = userText(message);
      if (text) addUserFacts(facts, text);
      continue;
    }

    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text") {
          addFilePaths(facts, part.text);
          continue;
        }
        if (part.type !== "toolCall") continue;
        const command = stringArgument(part.arguments, ["command", "cmd"]);
        if (command && COMMAND_TOOL_PATTERN.test(part.name)) {
          add(facts, "commands", command);
          addFilePaths(facts, command);
        }
        const path = stringArgument(part.arguments, [
          "file_path",
          "path",
          "filePath",
          "notebook_path",
        ]);
        if (path) add(facts, "files", path);
        if (PLAN_TOOL_PATTERN.test(part.name)) {
          latestPlan = unfinishedPlanItems(part.arguments) ?? latestPlan;
        }
      }
      continue;
    }

    // Tool results contribute errors only. Their listings and logs are the
    // bulky, low value content that compaction compresses hardest.
    if (message.isError) add(facts, "errors", errorFact(message));
  }

  // A plan update replaces the whole list, so only the latest one counts.
  if (latestPlan) {
    facts.openTasks = [];
    for (const task of latestPlan) add(facts, "openTasks", task);
  }
  return facts;
}

export function countCompactionFacts(
  facts: CompactionFacts,
): CompactionFactCounts {
  return {
    files: facts.files.length,
    commands: facts.commands.length,
    errors: facts.errors.length,
    requirements: facts.requirements.length,
    decisions: facts.decisions.length,
    openTasks: facts.openTasks.length,
  };
}

/**
 * Keeps the newest facts of each kind that fit in maxChars. Kinds take turns
 * so one noisy kind (hundreds of paths) cannot crowd out the others.
 */
export function capCompactionFacts(
  facts: CompactionFacts,
  maxChars: number = DEFAULT_FACTS_BLOCK_MAX_CHARS,
): CompactionFacts {
  const capped = emptyCompactionFacts();
  const next: Record<CompactionFactKind, number> = {
    files: facts.files.length - 1,
    commands: facts.commands.length - 1,
    errors: facts.errors.length - 1,
    requirements: facts.requirements.length - 1,
    decisions: facts.decisions.length - 1,
    openTasks: facts.openTasks.length - 1,
  };
  let used = PRESERVED_FACTS_HEADER.length;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const kind of FACT_KINDS) {
      const index = next[kind];
      if (index < 0) continue;
      const fact = facts[kind][index] as string;
      const cost =
        fact.length +
        5 +
        (capped[kind].length === 0 ? SECTION_LABELS[kind].length + 2 : 0);
      if (used + cost > maxChars) {
        next[kind] = -1;
        continue;
      }
      used += cost;
      capped[kind].unshift(fact);
      next[kind] = index - 1;
      progressed = true;
    }
  }
  return capped;
}

/** Renders the block, newest fact first within each kind. */
export function formatCompactionFactsBlock(facts: CompactionFacts): string {
  const lines: string[] = [];
  for (const kind of FACT_KINDS) {
    const list = facts[kind];
    if (list.length === 0) continue;
    lines.push(`${SECTION_LABELS[kind]}:`);
    for (const fact of [...list].reverse()) {
      lines.push(kind === "commands" ? `- \`${fact}\`` : `- ${fact}`);
    }
  }
  if (lines.length === 0) return "";
  return [PRESERVED_FACTS_HEADER, ...lines].join("\n");
}

/**
 * Appends the capped facts block to a model written summary, replacing any
 * facts block the model copied from an earlier summary so it appears once.
 */
export function appendCompactionFacts(
  summary: string,
  facts: CompactionFacts,
  maxChars: number = DEFAULT_FACTS_BLOCK_MAX_CHARS,
): string {
  const block = formatCompactionFactsBlock(capCompactionFacts(facts, maxChars));
  const headerIndex = summary.indexOf(PRESERVED_FACTS_HEADER);
  const base = (
    headerIndex === -1 ? summary : summary.slice(0, headerIndex)
  ).trimEnd();
  if (!block) return base;
  return base ? `${base}\n\n${block}` : block;
}
