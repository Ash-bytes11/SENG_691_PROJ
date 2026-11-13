import { afterEach, describe, expect, test } from "bun:test";
import { executeCommand } from "@/cli/commands/registry";
import { createBuffers, onChunk, toLines } from "@/cli/helpers/accumulator";
import { showPermissionExplanations } from "@/cli/helpers/permission-explanation-display";
import {
  clearLastPermissionDecisionForTests,
  formatLastPermissionDecision,
  formatPermissionDecision,
  recordPermissionDecision,
} from "./explanation";

describe("permission explanations", () => {
  afterEach(() => clearLastPermissionDecisionForTests());

  test("formats concise allow, ask, and deny decisions", () => {
    expect(
      formatPermissionDecision({
        decision: "allow",
        matchedRule: "Bash(git status)",
        reason: "Matched allow rule",
      }),
    ).toBe("Allowed: matched Bash(git status).");
    expect(
      formatPermissionDecision({
        decision: "ask",
        reason: "Default behavior for tool",
      }),
    ).toBe("Approval required: Default behavior for tool.");
    expect(
      formatPermissionDecision({
        decision: "deny",
        matchedRule: "Read(.env)",
        reason: "Matched deny rule",
      }),
    ).toBe("Denied: matched Read(.env).");
  });

  test("shows a detailed, redacted explanation for the latest decision", () => {
    recordPermissionDecision({
      decision: "deny",
      matchedRule: "Bash(curl:*) (session)",
      reason: "Matched deny rule",
      trace: {
        engine: "v2",
        toolName: "Bash",
        canonicalToolName: "Bash",
        query: "curl https://example.com api_key=do-not-display",
        events: [
          {
            stage: "deny-rules",
            matched: true,
            pattern: "Bash(curl:*) (session)",
            message: "Matched deny rule",
          },
        ],
      },
    });

    const output = formatLastPermissionDecision();
    expect(output).toContain("Denied: matched Bash(curl:*) (session).");
    expect(output).toContain("Rule scope: session");
    expect(output).toContain("Tool: Bash");
    expect(output).toContain("api_key=[REDACTED]");
    expect(output).not.toContain("do-not-display");
  });

  test("exposes the latest explanation through the slash command", async () => {
    recordPermissionDecision({
      decision: "allow",
      reason: "Read-only shell command",
    });

    const result = await executeCommand("/permission-explain");
    expect(result.success).toBe(true);
    expect(result.output).toContain("Allowed: Read-only shell command.");
  });

  test("attaches the concise explanation to the matching tool call", () => {
    const buffers = createBuffers();
    onChunk(buffers, {
      message_type: "approval_request_message",
      id: "request",
      date: new Date().toISOString(),
      tool_call: {
        tool_call_id: "call-1",
        name: "Bash",
        arguments: JSON.stringify({ command: "git status" }),
      },
    });

    showPermissionExplanations(buffers, [
      {
        approval: { toolCallId: "call-1" },
        permission: { decision: "allow", reason: "Read-only shell command" },
      },
    ]);

    const toolCall = toLines(buffers).find((line) => line.kind === "tool_call");
    expect(toolCall?.kind).toBe("tool_call");
    if (toolCall?.kind === "tool_call") {
      expect(toolCall.permissionExplanation).toBe(
        "Allowed: Read-only shell command.",
      );
    }
  });

  test("reports when the session has no recorded decision", async () => {
    const result = await executeCommand("/permission-explain");
    expect(result.success).toBe(true);
    expect(result.output).toBe(
      "No permission decision has been recorded in this session.",
    );
  });
});
