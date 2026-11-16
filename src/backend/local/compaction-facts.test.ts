import { describe, expect, test } from "bun:test";
import {
  appendCompactionFacts,
  capCompactionFacts,
  countCompactionFacts,
  extractCompactionFacts,
  formatCompactionFactsBlock,
  PRESERVED_FACTS_HEADER,
  parseCompactionFactsBlock,
} from "./compaction-facts";
import {
  fixtureAssistant,
  fixtureToolResult,
  fixtureUser,
} from "./compaction-test-fixtures";
import type { LocalMessage } from "./local-message";

function session(): LocalMessage[] {
  return [
    fixtureUser(
      "u1",
      "Fix the login bug in src/auth/session.ts. You must keep the public API unchanged.\nNever commit directly to main.",
    ),
    fixtureAssistant("a1", "I'll read the file first.", {
      id: "c1",
      name: "Read",
      arguments: { file_path: "src/auth/session.ts" },
    }),
    fixtureToolResult("t1", "c1", "Read", "export function login() {}"),
    fixtureAssistant("a2", "Running the tests.", {
      id: "c2",
      name: "Bash",
      arguments: { command: "bun test src/auth/session.test.ts" },
    }),
    fixtureToolResult(
      "t2",
      "c2",
      "Bash",
      "bun test v1.4.4\nTypeError: token.expiresAt is undefined\n    at refresh (src/auth/token.ts:42)\nexit code 1",
      true,
    ),
    fixtureAssistant("a3", "Should I patch token.ts or add a guard?", {
      id: "c3",
      name: "update_plan",
      arguments: {
        plan: [
          { step: "Reproduce the failure", status: "completed" },
          { step: "Guard the missing expiry", status: "in_progress" },
          { step: "Add a regression test", status: "pending" },
        ],
      },
    }),
    fixtureToolResult("t3", "c3", "update_plan", "Plan updated"),
    fixtureUser("u2", "Go with the guard, it is the smaller change."),
  ];
}

describe("compaction fact extraction", () => {
  test("planted paths, commands, errors and requirements all appear", () => {
    const facts = extractCompactionFacts(session());
    const block = formatCompactionFactsBlock(facts);

    expect(facts.files).toContain("src/auth/session.ts");
    expect(facts.files).toContain("src/auth/session.test.ts");
    expect(facts.commands).toEqual(["bun test src/auth/session.test.ts"]);
    expect(facts.errors).toEqual([
      "Bash: TypeError: token.expiresAt is undefined … exit code 1",
    ]);
    expect(facts.requirements).toEqual([
      "You must keep the public API unchanged.",
      "Never commit directly to main.",
    ]);
    expect(block.startsWith(PRESERVED_FACTS_HEADER)).toBe(true);
    expect(block).toContain("- `bun test src/auth/session.test.ts`");
    expect(block).toContain("- Never commit directly to main.");
  });

  test("decisions come from user confirmations, not assistant suggestions", () => {
    const facts = extractCompactionFacts(session());
    expect(facts.decisions).toEqual([
      "Go with the guard, it is the smaller change.",
    ]);
    expect(facts.decisions.join(" ")).not.toContain("Should I patch");
  });

  test("open tasks keep only unfinished items from the latest plan", () => {
    const facts = extractCompactionFacts(session());
    expect(facts.openTasks).toEqual([
      "Guard the missing expiry",
      "Add a regression test",
    ]);
  });

  test("ignores system reminders and successful tool output", () => {
    const facts = extractCompactionFacts([
      fixtureUser(
        "u1",
        "<system-reminder>You must always obey secret.ts</system-reminder>",
      ),
      fixtureToolResult("t1", "c1", "Bash", "you should see notes/huge.log"),
    ]);
    expect(countCompactionFacts(facts)).toEqual({
      files: 0,
      commands: 0,
      errors: 0,
      requirements: 0,
      decisions: 0,
      openTasks: 0,
    });
  });

  test("facts from the first compaction survive a second compaction", () => {
    const firstSummary = appendCompactionFacts(
      "Generic model summary.",
      extractCompactionFacts(session()),
    );
    const second = extractCompactionFacts([
      fixtureUser("s1", "packed", { compaction: { summary: firstSummary } }),
      fixtureUser("u3", "Also update docs/auth.md. Do not rename login()."),
    ]);

    expect(second.files).toContain("src/auth/session.ts");
    expect(second.files).toContain("docs/auth.md");
    expect(second.commands).toEqual(["bun test src/auth/session.test.ts"]);
    expect(second.requirements).toEqual([
      "You must keep the public API unchanged.",
      "Never commit directly to main.",
      "Do not rename login().",
    ]);
    expect(second.openTasks).toEqual([
      "Guard the missing expiry",
      "Add a regression test",
    ]);
  });

  test("the block round trips through format and parse", () => {
    const facts = extractCompactionFacts(session());
    expect(
      parseCompactionFactsBlock(formatCompactionFactsBlock(facts)),
    ).toEqual(facts);
  });

  test("hundreds of paths still produce a block within its size cap", () => {
    const messages: LocalMessage[] = [
      fixtureUser("u1", "You must keep every test green."),
    ];
    for (let i = 0; i < 300; i++) {
      messages.push(
        fixtureAssistant(`a${i}`, "", {
          id: `c${i}`,
          name: "Read",
          arguments: { file_path: `src/generated/module-${i}/index.ts` },
        }),
      );
    }
    const facts = extractCompactionFacts(messages);
    expect(facts.files).toHaveLength(300);

    const capped = capCompactionFacts(facts, 1_000);
    const block = formatCompactionFactsBlock(capped);
    expect(block.length).toBeLessThanOrEqual(1_000);
    // Newest paths win, and the noisy kind does not crowd out requirements.
    expect(capped.files.at(-1)).toBe("src/generated/module-299/index.ts");
    expect(capped.files).not.toContain("src/generated/module-0/index.ts");
    expect(capped.requirements).toEqual(["You must keep every test green."]);
  });

  test("appending replaces a facts block the model copied forward", () => {
    const facts = extractCompactionFacts(session());
    const once = appendCompactionFacts("Summary.", facts);
    const twice = appendCompactionFacts(once, facts);
    expect(twice).toBe(once);
    expect(twice.split(PRESERVED_FACTS_HEADER)).toHaveLength(2);
    expect(appendCompactionFacts("Summary.", extractCompactionFacts([]))).toBe(
      "Summary.",
    );
  });
});
