import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { requestAgentUserInputWithRenderer } from './agent-confirm';

const { listeners, ledger } = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown, response: unknown) => void>(),
  ledger: vi.fn().mockResolvedValue(null),
}));
vi.mock('electron', () => ({
  ipcMain: {
    once: (channel: string, callback: (event: unknown, response: unknown) => void) =>
      listeners.set(channel, callback),
    removeListener: (channel: string) => listeners.delete(channel),
  },
}));
vi.mock('./conversation-ledger/writer', () => ({ appendConversationLedgerShadowEvent: ledger }));

describe(' prompt outcome ownership', () => {
  afterEach(() => {
    listeners.clear();
    ledger.mockClear();
  });
  it.each([
    ['superseded', 'superseded'],
    [undefined, 'user_cancelled'],
    ['user_cancelled', 'user_cancelled'],
    ['timeout', 'invalid_response'],
    ['invented', 'invalid_response'],
  ])('preserves only the authorized renderer reason %s', async (reason, expected) => {
    let requestId = '';
    const window = {
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, payload: { requestId: string }) => {
          requestId = payload.requestId;
        },
      },
    };
    const result = requestAgentUserInputWithRenderer(window as BrowserWindow, {
      provider: 'application',
      conversationId: 'acceptance-conversation',
      questions: [
        {
          id: 'decision',
          header: 'Decision',
          prompt: 'Continue?',
          options: [],
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    });
    listeners.get(`agent:user-input:response:${requestId}`)!(null, {
      outcome: 'cancelled',
      answers: {},
      ...(reason ? { reason } : {}),
    });
    await expect(result).resolves.toEqual({ outcome: 'cancelled', answers: {}, reason: expected });
    expect(ledger).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: 'acceptance-conversation',
        payload: expect.objectContaining({ outcome: 'cancelled', reason: expected }),
      })
    );
  });
});
