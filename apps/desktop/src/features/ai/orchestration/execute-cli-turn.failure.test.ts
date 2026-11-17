import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BUILT_IN_AGENT_PERMISSIONS } from '../../../shared/agent-permissions';
import type { CliTranscriptAccumulator } from '../transports/cli';

const {
  platform,
  setConversationState,
  materializeCliToolBlocks,
  blocksToMessages,
  createInlineReferenceSession,
  inlineReferenceSession,
  inlineSessionState,
} = vi.hoisted(() => {
  const inlineSessionState = { cancelled: false };
  const inlineReferenceSession = {
    update: vi.fn((_blockId: string, source: string) => ({
      source,
      renderSource: source,
      parts: [],
    })),
    finalize: vi.fn(async () => ({
      blocks: new Map(),
      proposedRows: inlineSessionState.cancelled
        ? []
        : [
            {
              id: '11111111-1111-4111-8111-111111111111',
              entity_type: 'sequence',
              display_label: 'should-not-persist.gb',
              locator: 'git://workspace/should-not-persist.gb',
              deep_link_params: null,
              data: null,
              source: 'ai',
              status: 'created',
              workspace_scope: null,
              created_at: 1,
              updated_at: 1,
            },
          ],
      referencedRows: [],
    })),
    cancel: vi.fn(() => {
      inlineSessionState.cancelled = true;
    }),
  };
  const platformBridge = {
    path: { appDataDir: async () => '/app-data' },
    agentSession: {
      onEvent: vi.fn(() => vi.fn()),
      start: vi.fn(async () => ({
        sessionId: 'session-1',
        provider: 'codex-sdk' as const,
        authorityProfileId: 'profile-1',
        ok: false,
        text: '',
        error: 'CLI failed after emitting partial text.',
        durationMs: 1,
        stopState: 'failed' as const,
        workspaceProvenance: {
          policy: 'not-required' as const,
          grounded: false,
          completedWorkspaceTools: [],
          completedWorkspaceResources: [],
        },
      })),
      cancel: vi.fn(async () => ({ ok: true, cancelled: true, state: 'stop_requested' as const })),
    },
  };
  return {
    platform: vi.fn(() => platformBridge),
    setConversationState: vi.fn(),
    materializeCliToolBlocks: vi.fn(async () => []),
    blocksToMessages: vi.fn(() => []),
    createInlineReferenceSession: vi.fn(() => inlineReferenceSession),
    inlineReferenceSession,
    inlineSessionState,
  };
});

vi.mock('../../../platform', () => ({ platform }));
vi.mock('../../../db/entity-references', () => ({ getEntityReferencesByIds: vi.fn() }));
vi.mock('../assistant-routes', () => ({ getCliAuthorityProfileId: vi.fn(() => 'profile-1') }));
vi.mock('../cli-workspace-reconcile', () => ({
  scanWorkspaceFiles: vi.fn(),
  reconcileCliWorkspaceChanges: vi.fn(),
}));
vi.mock('../prompts/cli-prompt', () => ({
  buildAgentSdkPrompt: vi.fn(() => 'prompt'),
  buildAgentSdkContinuationPrompt: vi.fn(() => 'continuation prompt'),
}));
vi.mock('../transports/cli', () => ({
  createCliTranscriptAccumulator: vi.fn(),
  isCliTranscriptTraceEvent: vi.fn(() => false),
  materializeCliToolBlocks,
}));
vi.mock('./chat-projections', () => ({
  blocksToMessages,
  createdAtAfter: vi.fn(() => 1),
  hasMaterializedAssistantText: vi.fn(() => false),
}));
vi.mock('./chat-runtime', () => ({ setConversationState, chatProviderPhase: vi.fn() }));
vi.mock('../references/inline/session', () => ({ createInlineReferenceSession }));

import { executeCliTurn } from './execute-cli-turn';

describe('executeCliTurn failure finalization', () => {
  beforeEach(() => {
    inlineSessionState.cancelled = false;
    vi.clearAllMocks();
  });

  it('cancels inline proposals before materializing a failed CLI turn', async () => {
    const transcript: CliTranscriptAccumulator = {
      blocks: [],
      indexedItems: 0,
      append: vi.fn(),
      clear: vi.fn(),
    };
    const queueProposedEntityReference = vi.fn();
    const finishTurn = vi.fn(async () => undefined);

    await expect(
      executeCliTurn({
        set: vi.fn(),
        conversationId: 'conversation-1',
        turnId: 'turn-1',
        transport: 'codex-sdk',
        permissionMode: 'app-supervised',
        permissions: BUILT_IN_AGENT_PERMISSIONS,
        folders: [],
        expandedMessages: [],
        content: 'Inspect my workspace.',
        stagedReferenceIds: [],
        allowedExistingReferenceIds: [],
        workspaceScope: null,
        isWorkspaceScopeCurrent: () => true,
        workspacePath: null,
        controller: new AbortController(),
        transcript,
        queueTerminalMessage: vi.fn(),
        queueProposedEntityReference,
        queueMaterializedEntityReference: vi.fn(),
        finishTurn,
      })
    ).rejects.toThrow('CLI failed after emitting partial text.');

    expect(inlineReferenceSession.cancel).toHaveBeenCalledTimes(1);
    expect(inlineReferenceSession.finalize).toHaveBeenCalledTimes(1);
    expect(queueProposedEntityReference).not.toHaveBeenCalled();
    expect(finishTurn).toHaveBeenCalledWith(
      'failed',
      'CLI failed after emitting partial text.',
      'CLI failed after emitting partial text.'
    );
  });
});
