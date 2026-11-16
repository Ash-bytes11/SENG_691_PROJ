import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import {
  buildLocalAllCompactionPrompt,
  buildLocalSlidingWindowCompactionPrompt,
  computeLocalCompactionBudget,
  formatLocalMessagesForSummary,
  LOCAL_ALL_COMPACTION_PROMPT,
  LOCAL_SLIDING_WINDOW_COMPACTION_PROMPT,
  type LocalAllCompactionInput,
  localCompactionBudgetStats,
  summarizeLocalMessagesAll,
  summarizeLocalMessagesSlidingWindow,
} from "./compaction";
import { PRESERVED_FACTS_HEADER } from "./compaction-facts";
import {
  fixtureAssistant,
  fixtureToolResult,
  fixtureUser,
} from "./compaction-test-fixtures";
import { emptyLocalUsage, type LocalMessage } from "./local-message";

const PLANTED = [
  "src/billing/invoice.ts",
  "bun test src/billing/invoice.test.ts",
  "RangeError: invoice total is negative",
  "You must round totals to two decimals.",
];

function transcript(): LocalMessage[] {
  return [
    fixtureUser(
      "u1",
      `Fix the rounding bug. You must round totals to two decimals. ${"Background detail. ".repeat(400)}`,
    ),
    fixtureAssistant("a1", "Reading the invoice module.", {
      id: "c1",
      name: "Read",
      arguments: { file_path: "src/billing/invoice.ts" },
    }),
    fixtureToolResult(
      "t1",
      "c1",
      "Read",
      `HEAD-MARKER ${"x".repeat(50_000)} TAIL-MARKER`,
    ),
    fixtureAssistant("a2", "Running the tests.", {
      id: "c2",
      name: "Bash",
      arguments: { command: "bun test src/billing/invoice.test.ts" },
    }),
    fixtureToolResult(
      "t2",
      "c2",
      "Bash",
      `RangeError: invoice total is negative\n${"    at frame\n".repeat(2_000)}FINAL-LINE: 1 test failed`,
      true,
    ),
  ];
}

function stubInput(
  overrides: Partial<LocalAllCompactionInput> = {},
): LocalAllCompactionInput & { captured: Context[] } {
  const captured: Context[] = [];
  const reply: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Generic summary with no identifiers." }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: emptyLocalUsage(),
    stopReason: "stop",
    timestamp: 1,
  };
  return {
    conversationId: "conv-adaptive",
    agent: {
      id: "agent-local-1",
      name: "Local",
      description: null,
      system: "",
      tags: [],
      model: "opencode-go/glm-5.2",
      model_settings: {},
    },
    messages: transcript(),
    complete: async (_model, context) => {
      captured.push(context);
      return reply;
    },
    captured,
    ...overrides,
  };
}

function sentTranscript(context: Context | undefined): string {
  const content = context?.messages[0]?.content;
  return typeof content === "string" ? content : "";
}

describe("adaptive compaction budget", () => {
  test("an unknown window matches the fixed v0.34.2 limits exactly", () => {
    const sliding = computeLocalCompactionBudget({ mode: "sliding_window" });
    const all = computeLocalCompactionBudget({
      mode: "all",
      contextWindow: Number.NaN,
    });
    expect(sliding.adaptive).toBe(false);
    expect(sliding.summaryWordLimit).toBe(300);
    expect(all.summaryWordLimit).toBe(500);
    expect(sliding.toolReturnTruncationChars).toBe(2_000);
    expect(all.toolReturnTruncationChars).toBe(2_000);
  });

  test("the default prompts are unchanged", () => {
    expect(buildLocalAllCompactionPrompt()).toBe(LOCAL_ALL_COMPACTION_PROMPT);
    expect(buildLocalSlidingWindowCompactionPrompt()).toBe(
      LOCAL_SLIDING_WINDOW_COMPACTION_PROMPT,
    );
    expect(LOCAL_ALL_COMPACTION_PROMPT).toContain("under 500 words");
    expect(LOCAL_SLIDING_WINDOW_COMPACTION_PROMPT).toContain("under 300 words");
  });

  test("a 200k window yields a larger word limit than 32k, within floor and cap", () => {
    for (const mode of ["all", "sliding_window"] as const) {
      const floor = mode === "all" ? 500 : 300;
      const small = computeLocalCompactionBudget({
        mode,
        contextWindow: 32_000,
      });
      const large = computeLocalCompactionBudget({
        mode,
        contextWindow: 200_000,
      });
      const huge = computeLocalCompactionBudget({
        mode,
        contextWindow: 2_000_000,
      });
      expect(large.summaryWordLimit).toBeGreaterThan(small.summaryWordLimit);
      expect(small.summaryWordLimit).toBeGreaterThanOrEqual(floor);
      expect(huge.summaryWordLimit).toBe(3_000);
    }
    expect(
      computeLocalCompactionBudget({ mode: "all", contextWindow: 8_000 })
        .summaryWordLimit,
    ).toBe(500);
  });

  test("tool output is compressed harder on small windows and after overflow", () => {
    const small = computeLocalCompactionBudget({
      mode: "all",
      contextWindow: 32_000,
      contextTokensBefore: 28_000,
    });
    const large = computeLocalCompactionBudget({
      mode: "all",
      contextWindow: 200_000,
      contextTokensBefore: 170_000,
    });
    const overflow = computeLocalCompactionBudget({
      mode: "all",
      contextWindow: 200_000,
      contextTokensBefore: 210_000,
    });
    expect(small.toolReturnTruncationChars).toBe(800);
    expect(large.toolReturnTruncationChars).toBe(2_000);
    expect(overflow.toolReturnTruncationChars).toBe(1_000);
  });

  test("records why the limits were chosen", () => {
    const budget = computeLocalCompactionBudget({
      mode: "sliding_window",
      contextWindow: 200_000,
      contextTokensBefore: 182_000,
    });
    expect(budget.reason).toBe(
      "~182k of 200k tokens in use (91%): 3000 word summary, tool output compressed to 2000 chars.",
    );
    const stats = localCompactionBudgetStats(
      budget,
      `Summary.\n\n${PRESERVED_FACTS_HEADER}\nFiles:\n- a.ts\n- b.ts\nCommands:\n- \`ls\``,
    );
    expect(stats).toEqual({
      summary_word_limit: 3_000,
      tool_return_truncation_chars: 2_000,
      facts_preserved: {
        files: 2,
        commands: 1,
        errors: 0,
        requirements: 0,
        decisions: 0,
        openTasks: 0,
      },
      budget_reason: budget.reason,
    });
  });
});

describe("adaptive compaction summaries", () => {
  test("the budget's word limit reaches the model prompt", async () => {
    const input = stubInput({
      budget: computeLocalCompactionBudget({
        mode: "sliding_window",
        contextWindow: 128_000,
      }),
    });
    await summarizeLocalMessagesSlidingWindow(input);
    expect(input.captured[0]?.systemPrompt).toContain("under 1920 words");
  });

  test("a user supplied prompt reaches the model unchanged", async () => {
    const input = stubInput({
      prompt: "Summarize in pirate speak.",
      budget: computeLocalCompactionBudget({
        mode: "all",
        contextWindow: 200_000,
      }),
    });
    await summarizeLocalMessagesAll(input);
    expect(input.captured[0]?.systemPrompt).toBe("Summarize in pirate speak.");
  });

  test("without a budget the summary is exactly what the model returned", async () => {
    const input = stubInput();
    const summary = await summarizeLocalMessagesAll(input);
    expect(summary).toBe("Generic summary with no identifiers.");
    expect(sentTranscript(input.captured[0])).toContain("[truncated ");
  });

  test("a 50k character tool result shrinks while a long user requirement arrives intact", async () => {
    const input = stubInput({
      budget: computeLocalCompactionBudget({
        mode: "all",
        contextWindow: 200_000,
        contextTokensBefore: 150_000,
      }),
    });
    await summarizeLocalMessagesAll(input);
    const sent = sentTranscript(input.captured[0]);

    expect(sent).toContain(`${"Background detail. ".repeat(400)}`);
    expect(sent).toContain("HEAD-MARKER");
    expect(sent).toContain("TAIL-MARKER");
    expect(sent).toContain("[TRUNCATED: dropped ");
    expect(sent.length).toBeLessThan(20_000);
  });

  test("the last line of a failing tool result survives truncation", () => {
    const messages = transcript();
    const fixed = formatLocalMessagesForSummary(messages);
    const adaptive = formatLocalMessagesForSummary(messages, {
      truncationChars: 800,
      tiered: true,
    });
    expect(fixed).not.toContain("FINAL-LINE: 1 test failed");
    expect(adaptive).toContain("FINAL-LINE: 1 test failed");
    expect(adaptive).toContain("RangeError: invoice total is negative");
    expect(adaptive.length).toBeLessThan(fixed.length);
  });

  test("the same transcript under 32k and 200k windows keeps every planted fact", async () => {
    for (const contextWindow of [32_000, 200_000]) {
      const input = stubInput({
        budget: computeLocalCompactionBudget({
          mode: "sliding_window",
          contextWindow,
          contextTokensBefore: contextWindow * 0.9,
        }),
      });
      const summary = await summarizeLocalMessagesSlidingWindow(input);
      expect(summary).toContain(PRESERVED_FACTS_HEADER);
      for (const fact of PLANTED) expect(summary).toContain(fact);
    }
  });

  test("facts are appended after clipping so they are never cut off", async () => {
    const input = stubInput({
      clipChars: 10,
      budget: computeLocalCompactionBudget({ mode: "all" }),
    });
    const summary = await summarizeLocalMessagesAll(input);
    expect(summary.startsWith("Generic su... [summary truncated to fit]")).toBe(
      true,
    );
    for (const fact of PLANTED) expect(summary).toContain(fact);
  });
});
