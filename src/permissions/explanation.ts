import type {
  PermissionCheckResult,
  PermissionCheckTrace,
  PermissionDecision,
} from "./types";

const MAX_DETAIL_LENGTH = 300;

export interface PermissionDecisionRecord {
  decision: PermissionDecision;
  matchedRule?: string;
  reason?: string;
  trace?: PermissionCheckTrace;
  recordedAt: string;
}

let lastPermissionDecision: PermissionDecisionRecord | null = null;

const GENERIC_REASONS = new Set([
  "Matched allow rule",
  "Matched ask rule",
  "Matched alwaysAsk rule",
  "Matched deny rule",
  "Matched --allowedTools flag",
  "Matched --disallowedTools flag",
]);

function truncate(value: string): string {
  return value.length > MAX_DETAIL_LENGTH
    ? `${value.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : value;
}

function redact(value: string): string {
  return truncate(
    value
      .replace(/\b(bearer)\s+[^\s"']+/gi, "$1 [REDACTED]")
      .replace(
        /\b(api[_-]?key|access[_-]?token|password|secret)\b\s*([=:])\s*[^\s,"']+/gi,
        "$1$2[REDACTED]",
      ),
  );
}

function decisionLabel(decision: PermissionDecision): string {
  switch (decision) {
    case "allow":
      return "Allowed";
    case "deny":
      return "Denied";
    case "ask":
    case "alwaysAsk":
      return "Approval required";
  }
}

function ruleScope(record: PermissionDecisionRecord): string {
  const rule = record.matchedRule ?? "";
  if (rule.includes("(session)")) return "session";
  if (rule.includes("(CLI)")) return "command line";
  if (/hook/i.test(rule)) return "permission hook";
  if (/guard/i.test(rule)) return "safety guard";
  if (/\bmode\b/i.test(rule)) return "permission mode";
  if (/^mod\b/i.test(rule)) return "mod";
  if (record.matchedRule) return "configured permissions";
  return "built-in default";
}

export function formatPermissionDecision(
  permission: Pick<
    PermissionCheckResult,
    "decision" | "matchedRule" | "reason"
  >,
): string {
  const label = decisionLabel(permission.decision);
  const rule = permission.matchedRule?.trim();
  const reason = permission.reason?.trim();

  if (rule && (!reason || GENERIC_REASONS.has(reason))) {
    return `${label}: matched ${redact(rule)}.`;
  }
  if (reason) return `${label}: ${redact(reason)}.`;
  if (rule) return `${label}: matched ${redact(rule)}.`;
  return `${label}: no additional reason was provided.`;
}

export function recordPermissionDecision(
  result: PermissionCheckResult,
): PermissionDecisionRecord {
  lastPermissionDecision = {
    decision: result.decision,
    matchedRule: result.matchedRule,
    reason: result.reason,
    trace: result.trace,
    recordedAt: new Date().toISOString(),
  };
  return lastPermissionDecision;
}

export function clearLastPermissionDecisionForTests(): void {
  lastPermissionDecision = null;
}

export function formatLastPermissionDecision(): string {
  const record = lastPermissionDecision;
  if (!record)
    return "No permission decision has been recorded in this session.";

  const lines = [
    formatPermissionDecision(record),
    `Decision: ${record.decision}`,
    `Tool: ${record.trace?.canonicalToolName ?? record.trace?.toolName ?? "unknown"}`,
    `Rule scope: ${ruleScope(record)}`,
    `Matched rule: ${redact(record.matchedRule ?? "none")}`,
    `Reason: ${redact(record.reason ?? "none")}`,
  ];

  if (record.trace?.query) {
    lines.push(`Relevant input: ${redact(record.trace.query)}`);
  }

  const matchedStages =
    record.trace?.events.filter(
      (event) => event.matched || event.stage === "final-decision",
    ) ?? [];
  if (matchedStages.length > 0) {
    lines.push("Evaluation path:");
    for (const event of matchedStages) {
      const details = [event.pattern, event.message]
        .filter((value): value is string => Boolean(value))
        .map(redact)
        .join(" — ");
      lines.push(`- ${event.stage}${details ? `: ${details}` : ""}`);
    }
  }

  lines.push(`Recorded: ${record.recordedAt}`);
  return lines.join("\n");
}
