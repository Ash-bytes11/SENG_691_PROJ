/** Compaction stats as they arrive on a summary_message (snake_case). */
export interface CompactionStatsWire {
  trigger?: string;
  context_tokens_before?: number;
  context_tokens_after?: number;
  context_window?: number;
  messages_count_before?: number;
  messages_count_after?: number;
  facts_preserved?: Record<string, number>;
  budget_reason?: string;
}

/** Compaction stats as stored on a transcript event line. */
export interface CompactionEventStats {
  trigger?: string;
  contextTokensBefore?: number;
  contextTokensAfter?: number;
  contextWindow?: number;
  messagesCountBefore?: number;
  messagesCountAfter?: number;
  factsPreserved?: number;
  budgetReason?: string;
}

const TRIGGER_LABELS: Record<string, string> = {
  context_window_overflow: "context overflow",
  context_window_limit: "near context limit",
  manual: "manual /compact",
};

export function toCompactionEventStats(
  stats: CompactionStatsWire,
): CompactionEventStats {
  const facts = stats.facts_preserved
    ? Object.values(stats.facts_preserved).reduce(
        (total, count) => total + (typeof count === "number" ? count : 0),
        0,
      )
    : undefined;
  return {
    trigger: stats.trigger,
    contextTokensBefore: stats.context_tokens_before,
    contextTokensAfter: stats.context_tokens_after,
    contextWindow: stats.context_window,
    messagesCountBefore: stats.messages_count_before,
    messagesCountAfter: stats.messages_count_after,
    ...(facts !== undefined ? { factsPreserved: facts } : {}),
    ...(stats.budget_reason ? { budgetReason: stats.budget_reason } : {}),
  };
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.round(tokens));
}

/**
 * One line summary of a finished compaction, for example
 * "~182k → ~41k tokens (77% smaller) · near context limit · 23 facts kept".
 * Returns undefined when the token estimates are missing.
 */
export function formatCompactionStatsLine(
  stats: CompactionEventStats | undefined,
): string | undefined {
  const before = stats?.contextTokensBefore;
  const after = stats?.contextTokensAfter;
  if (typeof before !== "number" || typeof after !== "number") return undefined;

  let line = `~${formatTokens(before)} → ~${formatTokens(after)} tokens`;
  if (before > 0 && after < before) {
    line += ` (${Math.round((1 - after / before) * 100)}% smaller)`;
  }
  const trigger = stats?.trigger;
  if (trigger) {
    line += ` · ${TRIGGER_LABELS[trigger] ?? trigger.replaceAll("_", " ")}`;
  }
  const facts = stats?.factsPreserved;
  if (typeof facts === "number" && facts > 0) {
    line += ` · ${facts} ${facts === 1 ? "fact" : "facts"} kept`;
  }
  return line;
}
