import { describe, expect, it, vi } from 'vitest';
import { EMPTY_CONV_STATE, type ChatTurnSummary } from './chat-store-types';
import {
  markChatConversationDeleted,
  unmarkChatConversationDeleted,
  type ChatStore,
  type ChatStoreSet,
} from './chat-runtime';
import { createChatTurnLifecycle } from './chat-turn-lifecycle';
import type { ArtifactDeliveryDependencies } from './artifact-delivery';

const CONVERSATION_ID = 'conversation-1';
const TURN_ID = 'turn-1';
const REFERENCE_ID = '18fc9f38-4c9d-48b8-aeb3-14b44f2d34ae';

function runningTurn(): ChatTurnSummary {
  return {
    id: TURN_ID,
    conversationId: CONVERSATION_ID,
    routeKind: 'provider',
    hostId: 'direct-api:anthropic',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    transport: null,
    authorityProfileId: null,
    permissionMode: null,
    routeSnapshotJson: '{}',
    status: 'running',
    terminalReason: null,
    error: null,
    startedAt: 10,
    completedAt: null,
  };
}

function storeHarness(): { set: ChatStoreSet; read: () => ChatStore } {
  const conversationState = {
    ...EMPTY_CONV_STATE,
    turns: { [TURN_ID]: runningTurn() },
    activeTurnId: TURN_ID,
  };
  let state = {
    currentConversationId: CONVERSATION_ID,
    _convStates: new Map([[CONVERSATION_ID, conversationState]]),
    turns: conversationState.turns,
    activeTurnId: TURN_ID,
  } as unknown as ChatStore;
  const set: ChatStoreSet = (patch) => {
    state = {
      ...state,
      ...(typeof patch === 'function' ? patch(state) : patch),
    };
  };
  return { set, read: () => state };
}

describe('createChatTurnLifecycle', () => {
  it('does not persist terminal state after its conversation is deleted', async () => {
    const { set } = storeHarness();
    const commitTerminalState = vi.fn();
    const lifecycle = createChatTurnLifecycle({
      set,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      commitTerminalState,
    });
    markChatConversationDeleted(CONVERSATION_ID);
    try {
      await lifecycle.finishTurn('stopped', 'Deleted by user.');
      expect(commitTerminalState).not.toHaveBeenCalled();
    } finally {
      unmarkChatConversationDeleted(CONVERSATION_ID);
    }
  });

  it.each([
    'create_reference',
    'create_notebook_reference',
    'create_notebook',
    'update_notebook',
    'mol_save_view',
    'mol_save_to_notebook',
  ])(
    'atomically commits %s messages/references and terminalizes exactly once',
    async (toolName) => {
      const { set, read } = storeHarness();
      const commit = vi.fn().mockResolvedValue({ committed: true });
      const appendTerminalLedger = vi.fn();
      const appendMaterializedLedger = vi.fn();
      const lifecycle = createChatTurnLifecycle({
        set,
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
        commitTerminalState: commit,
        now: () => 42,
      });
      lifecycle.setTerminalLedgerAppender(appendTerminalLedger);
      lifecycle.setMaterializedLedgerAppender(appendMaterializedLedger);
      lifecycle.queueTerminalMessage({
        id: 'assistant-1',
        turnId: TURN_ID,
        role: 'assistant',
        content: 'Done.',
        createdAt: 30,
      });
      lifecycle.queueTerminalMessage({
        id: 'tool-1',
        turnId: TURN_ID,
        role: 'tool',
        content: JSON.stringify({
          input: { entityType: 'sequence' },
          output: { referenceId: REFERENCE_ID },
          isError: false,
        }),
        toolName,
        toolCallId: 'call-1',
        createdAt: 31,
      });
      lifecycle.queueProposedEntityReference({
        id: REFERENCE_ID,
        entity_type: 'sequence',
        display_label: 'pUC19.gb',
        locator: 'git://Research Workspace/pUC19.gb',
        deep_link_params: null,
        data: null,
        source: 'ai',
        status: 'created',
        workspace_scope: 'file:/workspace',
        created_at: 20,
        updated_at: 20,
      });

      await lifecycle.finishTurn('completed', 'completed');
      await lifecycle.finishTurn('failed', 'late failure', 'late failure');

      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit).toHaveBeenCalledWith(
        expect.objectContaining({
          turn_id: TURN_ID,
          conversation_id: CONVERSATION_ID,
          status: 'completed',
          completed_at: 42,
          messages: [
            expect.objectContaining({ reference_ids: [] }),
            expect.objectContaining({ reference_ids: [REFERENCE_ID] }),
          ],
          proposed_entity_references: [expect.objectContaining({ id: REFERENCE_ID })],
        })
      );
      expect(appendTerminalLedger).toHaveBeenCalledWith('completed', 'completed', null, 42);
      expect(appendMaterializedLedger).toHaveBeenCalledWith(
        expect.objectContaining({
          schema_version: 1,
          status: 'completed',
          messages: [
            expect.objectContaining({ reference_ids: [] }),
            expect.objectContaining({ reference_ids: [REFERENCE_ID] }),
          ],
          entity_references: [expect.objectContaining({ id: REFERENCE_ID })],
        }),
        42
      );
      expect(read()._convStates.get(CONVERSATION_ID)?.turns[TURN_ID]).toMatchObject({
        status: 'completed',
        terminalReason: 'completed',
        completedAt: 42,
      });
      expect(read()._convStates.get(CONVERSATION_ID)?.activeTurnId).toBeNull();
    }
  );

  it('never turns input or unrelated-tool referenceId fields into message references', async () => {
    const commit = vi.fn().mockResolvedValue({ committed: true });
    const lifecycle = createChatTurnLifecycle({
      set: storeHarness().set,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      commitTerminalState: commit,
    });
    lifecycle.queueTerminalMessage({
      id: 'failed-create-reference',
      turnId: TURN_ID,
      role: 'tool',
      toolName: 'create_reference',
      toolCallId: 'call-failed',
      content: JSON.stringify({
        input: { data: { referenceId: REFERENCE_ID } },
        output: { referenceId: null, error: 'invalid input' },
        isError: false,
      }),
      createdAt: 31,
    });
    lifecycle.queueTerminalMessage({
      id: 'unrelated-tool',
      turnId: TURN_ID,
      role: 'tool',
      toolName: 'find_features',
      toolCallId: 'call-unrelated',
      content: JSON.stringify({
        input: {},
        output: { result: { referenceId: REFERENCE_ID } },
        isError: false,
      }),
      createdAt: 32,
    });

    await lifecycle.finishTurn('completed', 'completed');

    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ reference_ids: [] }),
          expect.objectContaining({ reference_ids: [] }),
        ],
      })
    );
  });

  it('binds a create_reference message only to its successful output identity', async () => {
    const outputReferenceId = 'd12f4e19-d1cb-4cef-850c-c765b0bab320';
    const commit = vi.fn().mockResolvedValue({ committed: true });
    const lifecycle = createChatTurnLifecycle({
      set: storeHarness().set,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      commitTerminalState: commit,
    });
    lifecycle.queueTerminalMessage({
      id: 'successful-create-reference',
      turnId: TURN_ID,
      role: 'tool',
      toolName: 'create_reference',
      toolCallId: 'call-success',
      content: JSON.stringify({
        input: { data: { referenceId: REFERENCE_ID } },
        output: { referenceId: outputReferenceId },
        isError: false,
      }),
      createdAt: 31,
    });

    await lifecycle.finishTurn('completed', 'completed');

    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [expect.objectContaining({ reference_ids: [outputReferenceId] })],
      })
    );
  });

  it('attaches verified saved artifacts to the final answer and removes raw IDs', async () => {
    const designId = 'e8dd4c82-1d86-4149-9946-487c41d00ad7';
    const { set, read } = storeHarness();
    const commit = vi.fn().mockResolvedValue({ committed: true });
    const artifactDelivery: ArtifactDeliveryDependencies = {
      resolveSavedArtifact: async () => ({
        path: '/project/example.wpdesign.json',
        workspaceRoot: '/project',
      }),
    };
    const lifecycle = createChatTurnLifecycle({
      set,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      commitTerminalState: commit,
      artifactDeliveryDependencies: artifactDelivery,
    });
    const assistant = {
      id: 'assistant-artifact',
      turnId: TURN_ID,
      role: 'assistant' as const,
      content: `I saved the draft.\nDesign ID: ${designId}\nResource URI: waypoint://design/${designId}`,
      createdAt: 32,
    };
    set((state) => ({
      _convStates: new Map([
        ...state._convStates,
        [CONVERSATION_ID, { ...state._convStates.get(CONVERSATION_ID)!, messages: [assistant] }],
      ]),
    }));
    lifecycle.queueTerminalMessage({
      id: 'tool-artifact',
      turnId: TURN_ID,
      role: 'tool',
      toolName: 'create_design',
      content: JSON.stringify({
        input: { name: 'Example draft' },
        output: { designId, name: 'Example draft' },
        isError: false,
      }),
      createdAt: 31,
    });
    lifecycle.queueTerminalMessage(assistant);

    await lifecycle.finishTurn('completed', 'completed');

    const request = commit.mock.calls[0][0];
    expect(request.proposed_entity_references).toEqual([
      expect.objectContaining({
        entity_type: 'assembly',
        locator: `entity://assembly/${designId}`,
      }),
    ]);
    expect(request.messages[1].reference_ids).toEqual([request.proposed_entity_references[0].id]);
    expect(request.messages[1].message.content).toBe('I saved the draft.');
    expect(read()._convStates.get(CONVERSATION_ID)?.messages[0]).toMatchObject({
      content: 'I saved the draft.',
      referenceIds: [request.proposed_entity_references[0].id],
    });
  });

  it('preserves the explanation and clarification when one imported artifact is unavailable', async () => {
    const designId = 'e8dd4c82-1d86-4149-9946-487c41d00ad7';
    const documentId = '8a55ac70-b2a8-46d9-b19a-782974fcd2d2';
    const commit = vi.fn().mockResolvedValue({ committed: true });
    const lifecycle = createChatTurnLifecycle({
      set: storeHarness().set,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      commitTerminalState: commit,
      artifactDeliveryDependencies: {
        resolveSavedArtifact: async (claim) =>
          claim.kind === 'design'
            ? { path: '/project/draft.wpdesign.json', workspaceRoot: '/project' }
            : null,
      },
    });
    for (const [toolName, output] of [
      ['create_design', { designId, name: 'Incomplete draft' }],
      ['import_sequence', { imported: true, documentId, name: 'Donor source' }],
    ] as const) {
      lifecycle.queueTerminalMessage({
        id: toolName,
        turnId: TURN_ID,
        role: 'tool',
        toolName,
        content: JSON.stringify({ output, isError: false }),
        createdAt: 31,
      });
    }
    const explanation =
      'The draft is incomplete because the donor read failed. Which target species should I use?';
    lifecycle.queueTerminalMessage({
      id: 'answer',
      turnId: TURN_ID,
      role: 'assistant',
      content: explanation,
      createdAt: 32,
    });
    await lifecycle.finishTurn('completed', 'completed');
    const request = commit.mock.calls[0][0];
    expect(request.messages[2].message.content).toContain(explanation);
    expect(request.messages[2].message.content).toContain('Donor source');
    expect(request.proposed_entity_references).toHaveLength(1);
    expect(request.proposed_entity_references[0].locator).toBe(`entity://assembly/${designId}`);
  });

  it('blocks a claimed finished design without a successful saved-artifact receipt', async () => {
    const commit = vi.fn().mockResolvedValue({ committed: true });
    const lifecycle = createChatTurnLifecycle({
      set: storeHarness().set,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      commitTerminalState: commit,
    });
    lifecycle.queueTerminalMessage({
      id: 'unsupported-answer',
      turnId: TURN_ID,
      role: 'assistant',
      content: 'I built the plasmid. Design ID: e8dd4c82-1d86-4149-9946-487c41d00ad7',
      createdAt: 33,
    });

    await lifecycle.finishTurn('completed', 'completed');

    const request = commit.mock.calls[0][0];
    expect(request.proposed_entity_references).toEqual([]);
    expect(request.messages[0].reference_ids).toEqual([]);
    expect(request.messages[0].message.content).toBe(
      'I built the plasmid.\n\nNo saved artifact could be verified for the completion claim above.'
    );
  });
});
