export interface ResponsesFrame {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export async function* readResponsesFrames(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<ResponsesFrame> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/gu, '\n');
      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf('\n\n');
        let type = '';
        const dataLines: string[] = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        const payload = dataLines.join('\n');
        if (payload === '' || payload === '[DONE]') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          throw new ResponsesStreamError('the provider sent a frame that is not JSON');
        }
        yield { type, data: parsed as Record<string, unknown> };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class ResponsesStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponsesStreamError';
  }
}

export interface ReportedUsage {
  readonly status: 'reported' | 'missing';
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly reasoningTokens: number | null;
}

export function readUsage(response: unknown): ReportedUsage {
  const usage = (response as { usage?: Record<string, unknown> } | null)?.usage ?? {};
  const asNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  const inputTokens = asNumber(usage.input_tokens);
  const outputTokens = asNumber(usage.output_tokens);
  return {
    status: inputTokens !== null || outputTokens !== null ? 'reported' : 'missing',
    inputTokens,
    outputTokens,
    cacheReadTokens: asNumber(inputDetails?.cached_tokens),
    reasoningTokens: asNumber(outputDetails?.reasoning_tokens),
  };
}

export interface AssembledToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

export class ToolCallAssembler {
  private readonly open = new Map<string, { callId: string; name: string; args: string }>();

  opened(data: Record<string, unknown>): void {
    const item = data.item as Record<string, unknown> | null;
    if (item?.type !== 'function_call' && item?.type !== 'custom_tool_call') return;
    this.open.set(typeof item.id === 'string' ? item.id : '', {
      callId: typeof item.call_id === 'string' ? item.call_id : '',
      name: typeof item.name === 'string' ? item.name : '',
      args:
        typeof item.arguments === 'string'
          ? item.arguments
          : typeof item.input === 'string'
            ? item.input
            : '',
    });
  }

  delta(data: Record<string, unknown>): void {
    const entry = this.open.get(typeof data.item_id === 'string' ? data.item_id : '');
    if (entry && typeof data.delta === 'string') entry.args += data.delta;
  }

  closed(data: Record<string, unknown>): AssembledToolCall | null {
    const item = data.item as Record<string, unknown> | null;
    if (item?.type !== 'function_call' && item?.type !== 'custom_tool_call') return null;
    const itemId = typeof item.id === 'string' ? item.id : '';
    const entry = this.open.get(itemId);
    this.open.delete(itemId);
    const callId = entry?.callId ?? (typeof item.call_id === 'string' ? item.call_id : '');
    const name = entry?.name ?? (typeof item.name === 'string' ? item.name : '');
    const complete =
      typeof item.arguments === 'string'
        ? item.arguments
        : typeof item.input === 'string'
          ? item.input
          : '';
    const raw = complete !== '' ? complete : (entry?.args ?? '');
    if (callId === '' || name === '') {
      throw new ResponsesStreamError('the provider sent a tool call with no call id or no name');
    }
    let input: unknown = {};
    try {
      input = raw === '' ? {} : JSON.parse(raw);
    } catch {
      throw new ResponsesStreamError('the provider sent tool arguments that are not JSON');
    }
    return { callId, name, input };
  }
}
