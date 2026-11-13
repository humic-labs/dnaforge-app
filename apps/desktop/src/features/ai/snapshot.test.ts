import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChatState = vi.hoisted(() => ({
  messages: [
    {
      id: 'msg-1',
      role: 'user' as const,
      content: 'Hello',
      createdAt: 1000,
    },
    {
      id: 'msg-2',
      role: 'assistant' as const,
      content: 'Hi there',
      createdAt: 2000,
    },
    {
      id: 'msg-3',
      role: 'tool' as const,
      content: '{"result": "ok"}',
      toolName: 'list-files',
      toolCallId: 'tc-1',
      createdAt: 3000,
    },
  ],
  streamingBlocks: [{ type: 'text' as const, id: 'streaming-1', content: 'streaming...' }],
  isStreaming: true,
  currentConversationId: 'conv-abc',
  conversations: [],
  isLoading: false,
  error: null,
  pendingMessage: null,
}));

const mockSettingsState = vi.hoisted(() => ({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  isConfigured: true,
}));

const mockCanvasState = vi.hoisted(() => ({
  panels: {
    main: { id: 'main', tabs: [], activeTabId: null },
  },
}));

vi.mock('./hooks/useChat', () => ({
  useChatStore: { getState: () => mockChatState },
}));

vi.mock('./settings', () => ({
  useAISettingsStore: { getState: () => mockSettingsState },
}));

vi.mock('../canvas/store', () => ({
  useCanvasStore: { getState: () => mockCanvasState },
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    path: { appDataDir: vi.fn().mockResolvedValue('/mock/appdata') },
    fs: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeTextFile: vi.fn().mockResolvedValue(undefined),
    },
  }),
}));

import { captureChatSnapshot, captureAndSaveSnapshot, type ChatSnapshot } from './snapshot';

describe('captureChatSnapshot', () => {
  it('returns a snapshot with the correct shape and version', () => {
    const snap = captureChatSnapshot();

    expect(snap.version).toBe(1);
    expect(typeof snap.timestamp).toBe('number');
    expect(snap.timestamp).toBeGreaterThan(0);
  });

  it('serializes messages from the chat store', () => {
    const snap = captureChatSnapshot();

    expect(snap.messages).toHaveLength(3);

    expect(snap.messages[0]).toEqual({
      id: 'msg-1',
      role: 'user',
      content: 'Hello',
      createdAt: 1000,
    });

    expect(snap.messages[2]).toEqual({
      id: 'msg-3',
      role: 'tool',
      content: '{"result": "ok"}',
      toolName: 'list-files',
      toolCallId: 'tc-1',
      createdAt: 3000,
    });
  });

  it('omits toolName/toolCallId when not present', () => {
    const snap = captureChatSnapshot();

    expect(snap.messages[0]).not.toHaveProperty('toolName');
    expect(snap.messages[0]).not.toHaveProperty('toolCallId');
  });

  it('captures streaming state', () => {
    const snap = captureChatSnapshot();

    expect(snap.isStreaming).toBe(true);
    expect(snap.streamingBlocks).toHaveLength(1);
    expect(snap.streamingBlocks[0]).toEqual({ type: 'text', content: 'streaming...' });
  });

  it('captures panels from the canvas store', () => {
    const snap = captureChatSnapshot();

    expect(snap.panels).toEqual({
      main: { id: 'main', tabs: [], activeTabId: null },
    });
  });

  it('captures conversation ID and provider/model', () => {
    const snap = captureChatSnapshot();

    expect(snap.conversationId).toBe('conv-abc');
    expect(snap.provider).toBe('anthropic');
    expect(snap.model).toBe('claude-sonnet-4-6');
  });
});

describe('captureAndSaveSnapshot', () => {
  let writeTextMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        ...globalThis.navigator,
        clipboard: { writeText: writeTextMock },
      },
      writable: true,
      configurable: true,
    });
  });

  it('writes JSON to the snapshots directory and copies path to clipboard', async () => {
    const filePath = await captureAndSaveSnapshot();

    expect(filePath).toMatch(/^\/mock\/appdata\/snapshots\/chat-\d+\.json$/);
    expect(writeTextMock).toHaveBeenCalledWith(expect.stringContaining('Chat snapshot saved:'));
  });
});
