interface AssistantTrace {
  transport?: string;
  providerItemId?: string;
  sequence?: number;
  terminal?: string;
  display: { kind: string; text?: string };
  raw?: unknown;
  toolCalls?: readonly unknown[];
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function cliAssistantText(event: AssistantTrace): string | null {
  if (event.display.kind !== 'assistant_text') return null;
  const raw = record(event.raw);
  const item = record(raw?.item);
  const content = record(raw?.message)?.content;
  const claudeText =
    raw?.type === 'assistant' && Array.isArray(content)
      ? content
          .map(record)
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block!.text as string)
          .join('\n')
      : undefined;
  const text = typeof item?.text === 'string' ? item.text : (claudeText ?? event.display.text);
  return text?.trim() || null;
}
export function createCliAssistantTextAccumulator(): {
  append(event: AssistantTrace): void;
  text(): string;
} {
  const items = new Map<string, string>();
  return {
    append(event) {
      const text = cliAssistantText(event);
      if (text)
        items.set(
          `${event.transport}:${event.providerItemId ?? `sequence-${event.sequence}`}`,
          text
        );
    },
    text: () => [...items.values()].join('\n'),
  };
}

export function isCliTerminalFailureDiagnostic(event: AssistantTrace): boolean {
  return event.terminal === 'failed' && event.display.kind === 'error' && !event.toolCalls?.length;
}

export function isCodexAccountModelRejection(text: string): boolean {
  return (
    /ChatGPT\s+account/iu.test(text) && /model.{0,200}(?:not supported|unsupported)/iu.test(text)
  );
}
