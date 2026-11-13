import type { ModelMessage } from 'ai';
import type { ChatMessage } from './chat-types';
function wrapToolOutput(raw: unknown): { type: string; value: unknown } {
  if (raw === undefined || raw === null) {
    return { type: 'text', value: '' };
  }
  if (typeof raw === 'string') {
    return { type: 'text', value: raw };
  }
  return { type: 'json', value: raw };
}

export function convertToModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
      i++;
    } else if (msg.role === 'assistant') {
      const toolMessages: ChatMessage[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        toolMessages.push(messages[j]);
        j++;
      }

      if (toolMessages.length > 0) {
        const contentParts: Array<{ type: string; [key: string]: unknown }> = [];
        if (msg.content && msg.content.trim()) {
          contentParts.push({ type: 'text', text: msg.content });
        }

        const toolResultParts: Array<{ type: string; [key: string]: unknown }> = [];

        for (const toolMsg of toolMessages) {
          if (!toolMsg.toolCallId || !toolMsg.toolName) continue;
          try {
            const toolData = JSON.parse(toolMsg.content);
            contentParts.push({
              type: 'tool-call',
              toolCallId: toolMsg.toolCallId,
              toolName: toolMsg.toolName,
              input: toolData.input || {},
            });
            toolResultParts.push({
              type: 'tool-result',
              toolCallId: toolMsg.toolCallId,
              toolName: toolMsg.toolName,
              output: wrapToolOutput(toolData.output),
            });
          } catch (err) {
            console.warn(
              '[Chat] Unparseable tool message, using fallback:',
              toolMsg.toolCallId,
              err
            );
            contentParts.push({
              type: 'tool-call',
              toolCallId: toolMsg.toolCallId,
              toolName: toolMsg.toolName,
              input: {},
            });
            toolResultParts.push({
              type: 'tool-result',
              toolCallId: toolMsg.toolCallId,
              toolName: toolMsg.toolName,
              output: wrapToolOutput('[Error: tool result was not parseable]'),
            });
          }
        }

        if (contentParts.length > 0) {
          result.push({ role: 'assistant', content: contentParts } as ModelMessage);
        }
        if (toolResultParts.length > 0) {
          result.push({ role: 'tool', content: toolResultParts } as ModelMessage);
        }

        i = j;
      } else {
        result.push({ role: 'assistant', content: msg.content });
        i++;
      }
    } else if (msg.role === 'tool') {
      if (msg.toolCallId && msg.toolName) {
        try {
          const toolData = JSON.parse(msg.content);
          result.push({
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: msg.toolCallId,
                toolName: msg.toolName,
                input: toolData.input || {},
              },
            ],
          } as ModelMessage);
          result.push({
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: msg.toolCallId,
                toolName: msg.toolName,
                output: wrapToolOutput(toolData.output),
              },
            ],
          } as ModelMessage);
        } catch (err) {
          console.warn('[Chat] Skipping unparseable orphaned tool message:', msg.toolCallId, err);
        }
      }
      i++;
    } else {
      i++;
    }
  }

  return result;
}
