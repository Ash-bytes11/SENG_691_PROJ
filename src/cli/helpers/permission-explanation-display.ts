import { formatPermissionDecision } from "@/permissions/explanation";
import type { PermissionCheckResult } from "@/permissions/types";
import type { Buffers } from "./accumulator";

interface PermissionExplanationEntry {
  approval: { toolCallId: string };
  permission: PermissionCheckResult;
}

export function showPermissionExplanations(
  buffers: Buffers,
  entries: PermissionExplanationEntry[],
): void {
  for (const entry of entries) {
    const lineId = buffers.toolCallIdToLineId.get(entry.approval.toolCallId);
    if (!lineId) continue;
    const line = buffers.byId.get(lineId);
    if (line?.kind !== "tool_call") continue;
    buffers.byId.set(lineId, {
      ...line,
      permissionExplanation: formatPermissionDecision(entry.permission),
    });
  }
}
