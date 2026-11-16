#!/usr/bin/env bun
/**
 * Compaction benchmark for the adaptive context compaction enhancement.
 *
 * Runs unchanged on the phase1-baseline tag and on the enhancement branch:
 * it detects whether the adaptive budget exists and labels the run. Synthetic
 * coding sessions with 40 planted facts go through the real planner,
 * formatter and summarizer entry points. The model call is replaced by a stub
 * that returns a fixed generic summary, standing in for a lossy model, so
 * runs are free and repeatable.
 *
 *   bun run scripts/bench-compaction.ts [--json]
 */
import * as compaction from "../src/backend/local/compaction";
import type { LocalMessage } from "../src/backend/local/local-message";

type AnyFn = (...args: never[]) => unknown;
const adaptiveBudget = (compaction as Record<string, unknown>)
  .computeLocalCompactionBudget as AnyFn | undefined;
const VARIANT = adaptiveBudget ? "adaptive" : "baseline (fixed limits)";

const TURN_COUNTS = [50, 200, 500];
const WINDOWS = [32_000, 128_000, 200_000];
const PLANTED_PER_KIND = 10;
const OVERHEAD_RUNS = 20;
const STUB_SUMMARY = `I worked through the user's coding task step by step. ${"I inspected files, ran commands, and fixed problems as they came up. ".repeat(18)}`;

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(id: string, text: string, summary?: string): LocalMessage {
  return {
    id,
    role: "user",
    content: text,
    timestamp: 1,
    ...(summary ? { metadata: { compaction: { summary } } } : {}),
  };
}

function assistant(
  id: string,
  text: string,
  call?: { id: string; name: string; arguments: Record<string, unknown> },
): LocalMessage {
  return {
    id,
    role: "assistant",
    content: [
      { type: "text", text },
      ...(call
        ? [{ type: "toolCall" as const, ...call, arguments: call.arguments }]
        : []),
    ],
    api: "openai-responses",
    provider: "openai",
    model: "bench",
    usage,
    stopReason: "stop",
    timestamp: 1,
  } as LocalMessage;
}

function toolResult(
  id: string,
  callId: string,
  name: string,
  text: string,
  isError = false,
): LocalMessage {
  return {
    id,
    role: "toolResult",
    toolCallId: callId,
    toolName: name,
    content: [{ type: "text", text }],
    isError,
    timestamp: 1,
  };
}

const FILLER_LOG = "compiled module ok; 0 warnings; cache hit; ".repeat(70);

function fillerTurn(prefix: string, i: number): LocalMessage[] {
  return [
    user(`${prefix}-u${i}`, `Continue with step ${i} of the refactor.`),
    assistant(`${prefix}-a${i}`, `Working on step ${i}.`, {
      id: `${prefix}-c${i}`,
      name: "Bash",
      arguments: { command: "bun run build" },
    }),
    toolResult(`${prefix}-t${i}`, `${prefix}-c${i}`, "Bash", FILLER_LOG),
    assistant(`${prefix}-b${i}`, `Step ${i} is done.`),
  ];
}

/** A session of `turns` turns with 40 planted facts spread evenly. */
function buildSession(turns: number): {
  messages: LocalMessage[];
  planted: string[];
} {
  const messages: LocalMessage[] = [];
  const planted: string[] = [];
  const every = Math.max(1, Math.floor(turns / (PLANTED_PER_KIND * 4)));
  let plantIndex = 0;
  for (let i = 0; i < turns; i++) {
    const slot = i % every === 0 ? plantIndex++ : -1;
    if (slot < 0 || slot >= PLANTED_PER_KIND * 4) {
      messages.push(...fillerTurn("s", i));
      continue;
    }
    const n = Math.floor(slot / 4);
    const kind = slot % 4;
    if (kind === 0) {
      const path = `src/feature-${n}/handler-q${n}z.ts`;
      planted.push(path);
      messages.push(
        user(`p-u${i}`, `Look at the next handler.`),
        assistant(`p-a${i}`, "Reading it.", {
          id: `p-c${i}`,
          name: "Read",
          arguments: { file_path: path },
        }),
        toolResult(`p-t${i}`, `p-c${i}`, "Read", FILLER_LOG),
        assistant(`p-b${i}`, "Read."),
      );
    } else if (kind === 1) {
      const command = `bun test src/feature-${n} --seed ${7000 + n}`;
      planted.push(command);
      messages.push(
        user(`p-u${i}`, "Run the focused tests."),
        assistant(`p-a${i}`, "Running.", {
          id: `p-c${i}`,
          name: "Bash",
          arguments: { command },
        }),
        toolResult(`p-t${i}`, `p-c${i}`, "Bash", FILLER_LOG),
        assistant(`p-b${i}`, "Tests ran."),
      );
    } else if (kind === 2) {
      const error = `E${4100 + n}: widget-${n} failed checksum`;
      planted.push(error);
      messages.push(
        user(`p-u${i}`, "Try the deploy script."),
        assistant(`p-a${i}`, "Deploying.", {
          id: `p-c${i}`,
          name: "Bash",
          arguments: { command: "bun run deploy" },
        }),
        toolResult(
          `p-t${i}`,
          `p-c${i}`,
          "Bash",
          `${FILLER_LOG}\n${error}`,
          true,
        ),
        assistant(`p-b${i}`, "That failed; I will look into it."),
      );
    } else {
      const requirement = `You must keep rule-${n}-${900 + n} in every release.`;
      planted.push(requirement);
      messages.push(
        user(`p-u${i}`, requirement),
        assistant(`p-b${i}`, "Understood."),
      );
    }
  }
  return { messages, planted };
}

const agent = {
  id: "agent-bench",
  name: "Bench",
  description: null,
  system: "",
  tags: [],
  model: "opencode-go/glm-5.2",
  model_settings: {},
};

interface RunResult {
  mode: string;
  tokensBefore: number;
  tokensAfter: number;
  summarizerInputChars: number;
  messages: LocalMessage[];
}

async function compactOnce(
  messages: LocalMessage[],
  contextWindow: number,
): Promise<RunResult> {
  const tokensBefore = compaction.estimateLocalMessageTokens(messages);
  let summarizerInputChars = 0;
  const complete = (async (
    _model: unknown,
    context: { messages: unknown[] },
  ) => {
    const first = context.messages[0] as { content?: unknown };
    summarizerInputChars =
      typeof first?.content === "string" ? first.content.length : 0;
    return {
      role: "assistant",
      content: [{ type: "text", text: STUB_SUMMARY }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "stub",
      usage,
      stopReason: "stop",
      timestamp: 1,
    };
  }) as never;

  const summarize = async (
    mode: "all" | "sliding_window",
    toSummarize: LocalMessage[],
  ) => {
    const budget = adaptiveBudget
      ? (adaptiveBudget as (input: object) => unknown)({
          contextWindow,
          contextTokensBefore: tokensBefore,
          mode,
        })
      : undefined;
    const input = {
      conversationId: "bench",
      agent,
      messages: toSummarize,
      complete,
      ...(budget ? { budget } : {}),
    } as never;
    return mode === "all"
      ? compaction.summarizeLocalMessagesAll(input)
      : compaction.summarizeLocalMessagesSlidingWindow(input);
  };

  // Mirrors LocalBackend: sliding window first, full compaction as fallback.
  let mode = "sliding_window";
  let kept: LocalMessage[] = [];
  let summary = "";
  let tokensAfter = Number.POSITIVE_INFINITY;
  try {
    const plan = compaction.planLocalSlidingWindowCompaction(messages, {
      slidingWindowPercentage: 0.3,
      contextWindow,
    });
    summary = await summarize("sliding_window", plan.messagesToSummarize);
    kept = plan.messagesToKeep;
    tokensAfter =
      Math.ceil(summary.length / 4) +
      compaction.estimateLocalMessageTokens(kept);
  } catch (error) {
    if (!compaction.isLocalSlidingWindowCompactionPlanningError(error)) {
      throw error;
    }
  }
  if (tokensAfter >= contextWindow) {
    mode = "all";
    const plan = compaction.planLocalAllCompaction(messages);
    summary = await summarize("all", plan.messagesToSummarize);
    kept = plan.messagesToKeep;
    tokensAfter =
      Math.ceil(summary.length / 4) +
      compaction.estimateLocalMessageTokens(kept);
  }
  return {
    mode,
    tokensBefore,
    tokensAfter,
    summarizerInputChars,
    messages: [user("summary", `[summary]\n${summary}`, summary), ...kept],
  };
}

function retention(messages: LocalMessage[], planted: string[]): number {
  const haystack = JSON.stringify(messages);
  const found = planted.filter((fact) =>
    haystack.includes(JSON.stringify(fact).slice(1, -1)),
  ).length;
  return Math.round((found / planted.length) * 100);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function main(): Promise<void> {
  process.env.OPENCODE_API_KEY ||= "bench-key";
  const rows: Record<string, string | number>[] = [];
  for (const turns of TURN_COUNTS) {
    const { messages, planted } = buildSession(turns);
    for (const contextWindow of WINDOWS) {
      const first = await compactOnce(messages, contextWindow);

      // Two more rounds: the session continues, then compacts again.
      let current = first.messages;
      for (let round = 0; round < 2; round++) {
        const more = Math.max(8, Math.floor(turns * 0.3));
        for (let i = 0; i < more; i++) {
          current.push(...fillerTurn(`r${round}`, i));
        }
        current = (await compactOnce(current, contextWindow)).messages;
      }

      const timings: number[] = [];
      for (let run = 0; run < OVERHEAD_RUNS; run++) {
        const start = performance.now();
        await compactOnce(messages, contextWindow);
        timings.push(performance.now() - start);
      }

      rows.push({
        turns,
        window: `${contextWindow / 1000}k`,
        mode: first.mode,
        "tokens before": first.tokensBefore,
        "tokens after": first.tokensAfter,
        "reduction %": Math.round(
          (1 - first.tokensAfter / first.tokensBefore) * 100,
        ),
        "facts kept % (1x)": retention(first.messages, planted),
        "facts kept % (3x)": retention(current, planted),
        "summarizer input chars": first.summarizerInputChars,
        "median ms": Number(median(timings).toFixed(1)),
      });
    }
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ variant: VARIANT, rows }, null, 2));
    return;
  }
  console.log(`\nCompaction benchmark: ${VARIANT}`);
  console.log(
    `40 planted facts per session, stub summarizer, median of ${OVERHEAD_RUNS} runs\n`,
  );
  console.table(rows);
}

await main();
