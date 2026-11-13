import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  createModel: vi.fn(),
  startAgentSession: vi.fn(),
  prepareHosted: vi.fn(),
  startHostedTurn: vi.fn(),
  cancelPreparedHostedTurn: vi.fn(),
}));

vi.mock('ai', () => ({ streamText: mocks.streamText }));
vi.mock('../providers', () => ({ createModel: mocks.createModel }));
vi.mock('../../../platform', () => ({
  platform: () => ({ agentSession: { start: mocks.startAgentSession } }),
}));
vi.mock('../hosted-gateway', () => ({
  hostedCodexBridge: () => ({
    startTurn: mocks.startHostedTurn,
    cancelPreparedTurn: mocks.cancelPreparedHostedTurn,
  }),
  prepareHostedCodexContribution: mocks.prepareHosted,
}));

import {
  generateCliConversationTitle,
  generateHostedConversationTitle,
  generateProviderConversationTitle,
  normalizeGeneratedConversationTitle,
  visibleConversationText,
} from './conversation-title';

describe('conversation title generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createModel.mockResolvedValue({ modelId: 'test-model' });
    mocks.streamText.mockReturnValue({ text: Promise.resolve('"RNA Sequencing vs qPCR"') });
    mocks.startAgentSession.mockResolvedValue({ ok: true, text: 'RNA Sequencing vs qPCR' });
    mocks.prepareHosted.mockResolvedValue({ started: true, error: null });
    mocks.startHostedTurn.mockResolvedValue({
      ok: true,
      outcome: 'completed',
      text: 'RNA Sequencing vs qPCR',
    });
    mocks.cancelPreparedHostedTurn.mockResolvedValue({ ok: true });
  });

  it('keeps internal reference markers out of model input and generated labels', () => {
    expect(visibleConversationText('Compare methods [[ref:opaque-id]]')).toBe('Compare methods');
    expect(normalizeGeneratedConversationTitle('Title: “RNA Sequencing vs qPCR.”')).toBe(
      'RNA Sequencing vs qPCR'
    );
    expect(normalizeGeneratedConversationTitle('[[ref:opaque-id]]')).toBeNull();
  });

  it('names the first user request through the selected direct provider', async () => {
    const title = await generateProviderConversationTitle({
      provider: 'anthropic',
      modelName: 'test-model',
      apiKey: 'test-key',
      userText: 'Compare RNA sequencing and qPCR [[ref:opaque-id]]',
    });

    expect(title).toBe('RNA Sequencing vs qPCR');
    expect(mocks.createModel).toHaveBeenCalledWith('anthropic', 'test-key', 'test-model');
    const request = mocks.streamText.mock.calls[0]?.[0];
    expect(request.prompt).toContain('qPCR');
    expect(request.prompt).not.toContain('Assistant:');
    expect(request.prompt).not.toContain('[[ref:');
    expect(request.maxOutputTokens).toBeLessThanOrEqual(64);
  });

  it('uses a separate, tool-free CLI session without adding a visible chat turn', async () => {
    const title = await generateCliConversationTitle({
      session: {
        provider: 'codex-sdk',
        authorityProfileId: 'test-profile',
        model: 'test-model',
      },
      userText: 'Compare two expression methods',
    });

    expect(title).toBe('RNA Sequencing vs qPCR');
    expect(mocks.startAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex-sdk',
        authorityProfileId: 'test-profile',
        conversationId: null,
        turnId: null,
        cwd: null,
        toolExposure: 'none',
        workspaceGrounding: 'not-required',
      })
    );
  });

  it('labels a Hosted chat locally without starting a tool-capable background workflow', async () => {
    const title = await generateHostedConversationTitle({
      userText: 'Create a Gibson assembly [[ref:opaque-id]]',
    });

    expect(title).toBe('Create a Gibson assembly');
    expect(mocks.prepareHosted).not.toHaveBeenCalled();
    expect(mocks.startHostedTurn).not.toHaveBeenCalled();
    expect(mocks.cancelPreparedHostedTurn).not.toHaveBeenCalled();
  });

  it.each(['   \n\t', '[[ref:opaque-id]]'])(
    'keeps an empty visible Hosted title local for %j',
    async (userText) => {
      expect(await generateHostedConversationTitle({ userText })).toBeNull();
      expect(mocks.prepareHosted).not.toHaveBeenCalled();
      expect(mocks.startHostedTurn).not.toHaveBeenCalled();
      expect(mocks.cancelPreparedHostedTurn).not.toHaveBeenCalled();
      expect(mocks.streamText).not.toHaveBeenCalled();
      expect(mocks.startAgentSession).not.toHaveBeenCalled();
    }
  );
});
