import { afterEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('./conversation-ledger/writer', () => ({ appendConversationLedgerShadowEvent: ledger }));

const listeners = new Map<string, (event: unknown, response: unknown) => void>();
vi.mock('electron', () => ({
  ipcMain: {
    once: (channel: string, cb: (event: unknown, response: unknown) => void) =>
      listeners.set(channel, cb),
    removeListener: (channel: string) => listeners.delete(channel),
  },
}));

import {
  confirmDestructiveFileWithRenderer,
  requestAgentUserInputWithRenderer,
} from './agent-confirm';
import {
  AGENT_CONFIRM_DESTRUCTIVE_FILE_CANCEL_CHANNEL,
  AGENT_USER_INPUT_CANCEL_CHANNEL,
  agentUserInputResponseChannel,
  agentConfirmResponseChannel,
} from '../shared/agent-confirm-types';

interface Sent {
  channel: string;
  payload: { requestId: string };
}
function fakeWindow(opts: { destroyed?: boolean; throwOnSend?: boolean } = {}) {
  const sent: Sent[] = [];
  return {
    win: {
      isDestroyed: () => opts.destroyed ?? false,
      webContents: {
        send: (channel: string, payload: { requestId: string }) => {
          if (opts.throwOnSend) throw new Error('send failed');
          sent.push({ channel, payload });
        },
      },
    },
    sent,
  };
}
const req = { toolName: 'Write', operation: 'Overwrite file', resolvedPath: '/u/design.gb' };

describe('confirmDestructiveFileWithRenderer (fail-closed transport)', () => {
  afterEach(() => listeners.clear());

  it('denies (false) when there is no window', async () => {
    await expect(confirmDestructiveFileWithRenderer(null as never, req)).resolves.toBe('deny');
  });

  it('denies (false) when the window is destroyed', async () => {
    const { win } = fakeWindow({ destroyed: true });
    await expect(confirmDestructiveFileWithRenderer(win as never, req)).resolves.toBe('deny');
  });

  it('denies (false) when webContents.send throws', async () => {
    const { win } = fakeWindow({ throwOnSend: true });
    await expect(confirmDestructiveFileWithRenderer(win as never, req)).resolves.toBe('deny');
  });

  it('allows (true) only on an explicit { allow: true } reply', async () => {
    const { win, sent } = fakeWindow();
    const pending = confirmDestructiveFileWithRenderer(win as never, req);
    const requestId = sent[0].payload.requestId;
    listeners.get(agentConfirmResponseChannel(requestId))?.(null, { allow: true });
    await expect(pending).resolves.toBe('once');
  });

  it('denies (false) on an explicit { allow: false } reply', async () => {
    const { win, sent } = fakeWindow();
    const pending = confirmDestructiveFileWithRenderer(win as never, req);
    const requestId = sent[0].payload.requestId;
    listeners.get(agentConfirmResponseChannel(requestId))?.(null, { allow: false });
    await expect(pending).resolves.toBe('deny');
  });

  it('denies (false) on a malformed/undefined reply', async () => {
    const { win, sent } = fakeWindow();
    const pending = confirmDestructiveFileWithRenderer(win as never, req);
    const requestId = sent[0].payload.requestId;
    listeners.get(agentConfirmResponseChannel(requestId))?.(null, undefined);
    await expect(pending).resolves.toBe('deny');
  });

  it('denies (false) on timeout when no reply arrives', async () => {
    const { win, sent } = fakeWindow();
    const pending = confirmDestructiveFileWithRenderer(win as never, req, 5);
    const requestId = sent[0].payload.requestId;
    await expect(pending).resolves.toBe('deny');
    expect(sent).toContainEqual({
      channel: AGENT_CONFIRM_DESTRUCTIVE_FILE_CANCEL_CHANNEL,
      payload: { requestId },
    });
  });

  it('denies and dismisses the exact renderer dialog when the turn is stopped', async () => {
    const { win, sent } = fakeWindow();
    const controller = new AbortController();
    const pending = confirmDestructiveFileWithRenderer(
      win as never,
      req,
      90_000,
      controller.signal
    );
    const requestId = sent[0].payload.requestId;

    controller.abort();

    await expect(pending).resolves.toBe('deny');
    expect(sent).toContainEqual({
      channel: AGENT_CONFIRM_DESTRUCTIVE_FILE_CANCEL_CHANNEL,
      payload: { requestId },
    });
    expect(listeners.has(agentConfirmResponseChannel(requestId))).toBe(false);
  });
});

describe('requestAgentUserInputWithRenderer', () => {
  afterEach(() => listeners.clear());

  const question = {
    provider: 'claude-agent-sdk' as const,
    conversationId: 'conversation-1',
    questions: [
      {
        id: 'method',
        header: 'Assembly',
        prompt: 'Which method?',
        options: [
          { id: 'gibson', label: 'Gibson', description: 'Overlap assembly' },
          { id: 'golden-gate', label: 'Golden Gate', description: 'Type IIS assembly' },
        ],
        multiSelect: false,
        allowFreeText: true,
      },
    ],
  };

  it('returns the exact structured answer from the renderer', async () => {
    const { win, sent } = fakeWindow();
    const pending = requestAgentUserInputWithRenderer(win as never, question);
    const requestId = sent[0].payload.requestId;
    listeners.get(agentUserInputResponseChannel(requestId))?.(null, {
      outcome: 'submitted',
      answers: { method: { selectedOptionIds: ['gibson'], text: 'Use 20 bp overlaps' } },
    });

    await expect(pending).resolves.toEqual({
      outcome: 'submitted',
      answers: { method: { selectedOptionIds: ['gibson'], text: 'Use 20 bp overlaps' } },
    });
  });

  it('returns cancellation and dismisses the exact card on timeout', async () => {
    const { win, sent } = fakeWindow();
    const pending = requestAgentUserInputWithRenderer(win as never, question, 5);
    const requestId = sent[0].payload.requestId;

    await expect(pending).resolves.toEqual({
      outcome: 'cancelled',
      answers: {},
      reason: 'timeout',
    });
    expect(sent).toContainEqual({
      channel: AGENT_USER_INPUT_CANCEL_CHANNEL,
      payload: { requestId },
    });
  });

  it('fails closed when the renderer submits malformed option IDs', async () => {
    const { win, sent } = fakeWindow();
    const pending = requestAgentUserInputWithRenderer(win as never, question);
    const requestId = sent[0].payload.requestId;
    listeners.get(agentUserInputResponseChannel(requestId))?.(null, {
      outcome: 'submitted',
      answers: { method: { selectedOptionIds: ['invented-option'] } },
    });

    await expect(pending).resolves.toEqual({
      outcome: 'cancelled',
      answers: {},
      reason: 'invalid_response',
    });
  });

  it('treats Stop as cancellation, dismisses the exact card, and ignores a late reply', async () => {
    const { win, sent } = fakeWindow();
    const controller = new AbortController();
    const pending = requestAgentUserInputWithRenderer(
      win as never,
      question,
      undefined,
      controller.signal
    );
    const requestId = sent[0].payload.requestId;

    controller.abort();

    await expect(pending).resolves.toEqual({
      outcome: 'cancelled',
      answers: {},
      reason: 'turn_aborted',
    });
    expect(sent).toContainEqual({
      channel: AGENT_USER_INPUT_CANCEL_CHANNEL,
      payload: { requestId },
    });
    expect(listeners.has(agentUserInputResponseChannel(requestId))).toBe(false);
  });
});

it('retains the approval timeout cause without recording question contents', async () => {
  const { win } = fakeWindow();
  await requestAgentUserInputWithRenderer(
    win as never,
    {
      provider: 'codex-sdk',
      conversationId: 'conversation-with-approval',
      questions: [
        {
          id: 'secret',
          header: 'Private',
          prompt: 'private-question',
          options: [],
          multiSelect: false,
          allowFreeText: true,
          secret: true,
        },
      ],
    },
    1
  );
  expect(ledger).toHaveBeenCalledWith(
    expect.objectContaining({
      conversation_id: 'conversation-with-approval',
      stream_event_type: 'agent.user-input.resolved',
      payload: expect.objectContaining({ outcome: 'cancelled', reason: 'timeout' }),
    })
  );
  expect(JSON.stringify(ledger.mock.calls)).not.toContain('private-question');
});
