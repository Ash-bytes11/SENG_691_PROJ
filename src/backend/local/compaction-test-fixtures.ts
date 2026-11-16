import { emptyLocalUsage, type LocalMessage } from "./local-message";

/** Message builders shared by the adaptive compaction tests and benchmark. */
export function fixtureUser(
  id: string,
  text: string,
  metadata?: LocalMessage["metadata"],
): LocalMessage {
  return {
    id,
    role: "user",
    content: text,
    timestamp: 1,
    ...(metadata ? { metadata } : {}),
  };
}

export function fixtureAssistant(
  id: string,
  text: string,
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> },
): LocalMessage {
  return {
    id,
    role: "assistant",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...(toolCall
        ? [
            {
              type: "toolCall" as const,
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments as never,
            },
          ]
        : []),
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: emptyLocalUsage(),
    stopReason: "stop",
    timestamp: 1,
  };
}

export function fixtureToolResult(
  id: string,
  toolCallId: string,
  toolName: string,
  text: string,
  isError = false,
): LocalMessage {
  return {
    id,
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: 1,
  };
}
