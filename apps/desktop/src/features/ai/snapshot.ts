import { useChatStore } from './hooks/useChat';
import { useAISettingsStore } from './settings';
import { useCanvasStore } from '../canvas/public/store';
import { platform } from '../../platform';

export interface ChatSnapshot {
  version: 1;
  timestamp: number;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    toolName?: string;
    toolCallId?: string;
    createdAt: number;
  }>;
  streamingBlocks: Array<{
    type: string;
    content?: string;
    message?: unknown;
    trace?: {
      transport: string;
      providerEventType: string;
      providerItemType?: string;
      display: unknown;
      terminal?: string;
    };
  }>;
  isStreaming: boolean;
  panels: Record<string, unknown>;
  conversationId: string | null;
  provider: string;
  model: string;
}

export function captureChatSnapshot(): ChatSnapshot {
  const chat = useChatStore.getState();
  const settings = useAISettingsStore.getState();
  const canvas = useCanvasStore.getState();

  return {
    version: 1,
    timestamp: Date.now(),
    messages: chat.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      ...(m.toolName ? { toolName: m.toolName } : {}),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
      createdAt: m.createdAt,
    })),
    streamingBlocks: chat.streamingBlocks.map((b) => ({
      type: b.type,
      ...(b.type === 'text' || b.type === 'assistant_text' ? { content: b.content } : {}),
      ...(b.type === 'tool' ? { message: b.message } : {}),
      ...(b.type === 'trace'
        ? {
            trace: {
              transport: b.event.transport,
              providerEventType: b.event.providerEventType,
              providerItemType: b.event.providerItemType,
              display: b.event.display,
              terminal: b.event.terminal,
            },
          }
        : {}),
    })),
    isStreaming: chat.isStreaming,
    panels: canvas.panels,
    conversationId: chat.currentConversationId,
    provider: settings.provider,
    model: settings.model,
  };
}

export async function captureAndSaveSnapshot(): Promise<string> {
  const snapshot = captureChatSnapshot();

  const appData = await platform().path.appDataDir();
  const snapshotDir = `${appData}/snapshots`;

  try {
    await platform().fs.mkdir(snapshotDir, { recursive: true });
  } catch {}

  const fileName = `chat-${snapshot.timestamp}.json`;
  const filePath = `${snapshotDir}/${fileName}`;

  await platform().fs.writeTextFile(filePath, JSON.stringify(snapshot, null, 2));

  const clipboardText = `Chat snapshot saved: ${filePath}`;
  try {
    await navigator.clipboard.writeText(clipboardText);
  } catch {
    console.warn('[ChatSnapshot] Could not copy to clipboard');
  }

  console.log(`[ChatSnapshot] Saved to: ${filePath}`);
  return filePath;
}
