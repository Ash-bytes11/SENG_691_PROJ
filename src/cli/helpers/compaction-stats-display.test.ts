import { describe, expect, test } from "bun:test";
import {
  formatCompactionStatsLine,
  toCompactionEventStats,
} from "./compaction-stats-display";

describe("compaction stats display", () => {
  test("shows tokens before and after, the trigger and the facts kept", () => {
    const stats = toCompactionEventStats({
      trigger: "context_window_limit",
      context_tokens_before: 182_000,
      context_tokens_after: 41_500,
      context_window: 200_000,
      messages_count_before: 120,
      messages_count_after: 31,
      facts_preserved: { files: 12, commands: 6, errors: 2, requirements: 3 },
      budget_reason: "reason",
    });
    expect(stats.factsPreserved).toBe(23);
    expect(stats.budgetReason).toBe("reason");
    expect(formatCompactionStatsLine(stats)).toBe(
      "~182k → ~42k tokens (77% smaller) · near context limit · 23 facts kept",
    );
  });

  test("older stats without the new fields still render", () => {
    const stats = toCompactionEventStats({
      trigger: "manual",
      context_tokens_before: 900,
      context_tokens_after: 400,
    });
    expect(stats.factsPreserved).toBeUndefined();
    expect(formatCompactionStatsLine(stats)).toBe(
      "~900 → ~400 tokens (56% smaller) · manual /compact",
    );
  });

  test("returns nothing when token estimates are missing", () => {
    expect(formatCompactionStatsLine(undefined)).toBeUndefined();
    expect(formatCompactionStatsLine({ trigger: "manual" })).toBeUndefined();
  });
});
