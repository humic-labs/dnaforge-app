import { describe, expect, it, vi } from 'vitest';
import { BUILT_IN_AGENT_PERMISSIONS } from '../../../shared/agent-permissions';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MarkdownMessage } from '../../../components/chat/MarkdownMessage';
import { getEntityReferencesByIds } from '../../../db/entity-references';
import type { HostedCodexBridge } from '../hosted-gateway';
import {
  executeHostedCodexTurn,
  HostedCodexTurnExecutionError,
  type ExecuteHostedCodexTurnOptions,
} from './execute-hosted-codex-turn';
import type { ChatStore, ChatStoreGet, ChatStoreSet } from './chat-runtime';
import { createEmptyConversationState } from './chat-store-types';
import {
  appendHostedCodexTurnJournal,
  hostedCodexAnswerSha256,
  HOSTED_CODEX_TURN_JOURNAL_FILE,
} from '../../../main/hosted-codex/turn-journal';

vi.mock('../../../db/entity-references', () => ({
  getEntityReferencesByIds: vi.fn(),
}));

describe('executeHostedCodexTurn', () => {
  it.each([false, true])(
    'renders the persisted pause marker after Stop (inline reference: %s)',
    async (withReference) => {
      const conversationId = 'conversation-stop';
      const turnId = 'turn-stop';
      const referenceId = 'e0b34177-a7d4-4cf6-9529-42526df462f5';
      const reference = {
        id: referenceId,
        entity_type: 'sequence',
        display_label: 'pUC19.gb',
        locator: 'git://qualification-workspace/pUC19.gb',
        deep_link_params: null,
        data: null,
        source: 'ai',
        status: 'created',
        workspace_scope: null,
        workspace_root_path: '/qualification-workspace',
        created_at: 1,
        updated_at: 1,
      };
      vi.mocked(getEntityReferencesByIds).mockResolvedValue([reference]);
      let store = {
        _convStates: new Map([[conversationId, createEmptyConversationState()]]),
        currentConversationId: conversationId,
      } as unknown as ChatStore;
      const set: ChatStoreSet = (patch) => {
        store = { ...store, ...(typeof patch === 'function' ? patch(store) : patch) };
      };
      const get: ChatStoreGet = () => store;
      const listeners = new Set<Parameters<HostedCodexBridge['onTurnEvent']>[0]>();
      const partial = withReference
        ? `Useful partial answer about [pUC19](dnaforge-chat://reference/${referenceId}).`
        : 'Qualification partial output persisted before Stop.';
      const bridge: HostedCodexBridge = {
        prepareContribution: vi.fn(),
        cancelPreparedTurn: vi.fn(async () => ({ ok: true })),
        stopTurn: vi.fn(async () => ({ ok: true })),
        onTurnEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        startTurn: vi.fn(async (request) => {
          for (const listener of listeners)
            listener({
              workflowId: request.workflowId,
              runId: request.runId,
              turnId: request.turnId,
              kind: 'text_delta',
              delta: partial,
            });
          if (withReference)
            await vi.waitFor(() => {
              const block = store._convStates.get(conversationId)?.streamingBlocks[0];
              expect(block?.type === 'text' && block.document?.parts[0]?.state.status).toBe(
                'resolved'
              );
            });
          return {
            ok: true as const,
            outcome: 'stopped' as const,
            text: partial,
            gateway: {
              gatewayOrigin: 'https://gateway.test',
              catalogVersion: 'catalog-v1',
              rateCardVersion: 'rate-v1',
              reservationIds: ['reservation-stop'],
              usageEventIds: ['usage-stop'],
              workflowRunId: 'workflow-stop',
              workflowStepId: 'step-stop',
              completedToolCallIds: [],
              terminalError: null,
            },
            artifact: {
              desktopSourceCommit: 'source-commit',
              appServerVersion: '0.148.0',
              appServerSha256: 'app-server-sha',
              appServerTarget: 'aarch64-apple-darwin',
            },
          };
        }),
      };
      const options: ExecuteHostedCodexTurnOptions = {
        bridge,
        set,
        get,
        conversationId,
        turnId,
        tier: 'auto',
        permissions: BUILT_IN_AGENT_PERMISSIONS,
        folders: [],
        expandedMessages: [
          { id: 'user-stop', turnId, role: 'user', content: 'Start a response.', createdAt: 1 },
        ],
        currentUserMessageId: 'user-stop',
        stagedReferenceIds: [],
        allowedExistingReferenceIds: withReference ? [referenceId] : [],
        workspaceScope: null,
        isWorkspaceScopeCurrent: () => true,
        workspacePath: '/qualification-workspace',
        controller: new AbortController(),
        queueTerminalMessage: vi.fn(),
        queueProposedEntityReference: vi.fn(),
        queueMaterializedEntityReference: vi.fn(),
        finishTurn: vi.fn(),
      };
      await expect(executeHostedCodexTurn(options)).resolves.toBe('stopped');
      const message = store._convStates.get(conversationId)?.messages.at(-1);
      expect(message?.content).toBe(partial + '\n\n*[Stopped. Send a follow-up to resume.]*');
      const terminalResult = await vi.mocked(bridge.startTurn).mock.results[0]!.value;
      expect(terminalResult.ok).toBe(true);
      if (!terminalResult.ok) throw new Error('Expected the stopped turn result');
      const journalRoot = mkdtempSync(join(tmpdir(), 'hosted-stop-answer-'));
      try {
        const journal = await appendHostedCodexTurnJournal({
          userDataRoot: journalRoot,
          identity: { workflowId: 'workflow-stop', runId: turnId, turnId },
          gateway: terminalResult.gateway,
          artifact: terminalResult.artifact,
          transport: { requestSizes: [], responseStreams: [], childFailure: null },
          outcome: terminalResult.outcome,
          answer: terminalResult.text,
        });
        expect(journal.answerSha256).toBe(hostedCodexAnswerSha256(message!.content));
        const bytes = readFileSync(
          join(journalRoot, 'logs', HOSTED_CODEX_TURN_JOURNAL_FILE),
          'utf8'
        );
        expect(JSON.parse(bytes).answerSha256).toBe(journal.answerSha256);
        expect(bytes).not.toContain(partial);
      } finally {
        rmSync(journalRoot, { recursive: true, force: true });
      }
      expect(message?.document).toBeDefined();
      const html = renderToStaticMarkup(
        createElement(MarkdownMessage, {
          content: message!.content,
          document: message!.document,
          renderInlineReference: (part) =>
            createElement(
              'span',
              {
                'data-reference-id': part.state.status === 'resolved' ? part.state.referenceId : '',
              },
              part.label
            ),
        })
      );
      const rendered = document.createElement('div');
      rendered.innerHTML = html;
      expect(rendered.querySelector('em')?.textContent).toBe(
        '[Stopped. Send a follow-up to resume.]'
      );
      expect(html).toContain(withReference ? 'Useful partial answer about' : partial);
      expect(message?.document?.source).toBe(message?.content);
      if (withReference) {
        expect(html).toContain(`data-reference-id="${referenceId}"`);
        expect(message?.document?.parts[0]?.state).toMatchObject({
          status: 'resolved',
          referenceId,
          reference,
        });
        expect(message?.referenceIds).toEqual([referenceId]);
      }
      expect(options.queueTerminalMessage).toHaveBeenCalledWith(message, message?.referenceIds);
      expect(store._convStates.get(conversationId)?.isStreaming).toBe(false);
      expect(listeners.size).toBe(0);
    }
  );

  it.each(['create_reference', 'create_notebook_reference', 'create_notebook', 'update_notebook'])(
    'materializes a completed %s result as an admitted visible reference block',
    async (toolName) => {
      const conversationId = 'conversation-reference';
      const turnId = 'turn-reference';
      const referenceId = 'e0b34177-a7d4-4cf6-9529-42526df462f5';
      const reference = {
        id: referenceId,
        entity_type: 'sequence',
        display_label: 'pUC19.gb',
        locator: 'git://qualification-workspace/pUC19.gb',
        deep_link_params: null,
        data: null,
        source: 'ai',
        status: 'created',
        workspace_scope: 'folders:["/qualification-workspace"]',
        workspace_root_path: '/qualification-workspace',
        created_at: 1,
        updated_at: 1,
      };
      vi.mocked(getEntityReferencesByIds).mockResolvedValue([reference]);

      let store = {
        _convStates: new Map([[conversationId, createEmptyConversationState()]]),
        currentConversationId: conversationId,
      } as unknown as ChatStore;
      const set: ChatStoreSet = (patch) => {
        const resolved = typeof patch === 'function' ? patch(store) : patch;
        store = { ...store, ...resolved };
      };
      const get: ChatStoreGet = () => store;
      const listeners = new Set<Parameters<HostedCodexBridge['onTurnEvent']>[0]>();
      const answer = 'Created a sequence reference for the open pUC19.gb file.';
      const bridge: HostedCodexBridge = {
        prepareContribution: vi.fn(),
        cancelPreparedTurn: vi.fn(async () => ({ ok: true })),
        stopTurn: vi.fn(async () => ({ ok: true })),
        onTurnEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        startTurn: vi.fn(async (request) => {
          for (const listener of listeners) {
            listener({
              workflowId: request.workflowId,
              runId: request.runId,
              turnId: request.turnId,
              kind: 'tool_completed',
              toolCallId: 'call-create-reference',
              toolName,
              input: { entityType: 'sequence', displayLabel: 'pUC19.gb', filePath: 'pUC19.gb' },
              output: { referenceId },
              isError: false,
            });
            listener({
              workflowId: request.workflowId,
              runId: request.runId,
              turnId: request.turnId,
              kind: 'text_delta',
              delta: answer,
            });
          }
          return {
            ok: true as const,
            outcome: 'completed' as const,
            text: answer,
            gateway: {
              gatewayOrigin: 'https://gateway.test',
              catalogVersion: 'catalog-v1',
              rateCardVersion: 'rate-v1',
              reservationIds: ['reservation-1', 'reservation-2'],
              usageEventIds: ['usage-1', 'usage-2'],
              workflowRunId: 'workflow-run-1',
              workflowStepId: 'workflow-step-1',
              completedToolCallIds: ['call-create-reference'],
              terminalError: null,
            },
            artifact: {
              desktopSourceCommit: 'source-commit',
              appServerVersion: '0.148.0',
              appServerSha256: 'app-server-sha',
              appServerTarget: 'aarch64-apple-darwin',
            },
          };
        }),
      };
      const options: ExecuteHostedCodexTurnOptions = {
        bridge,
        set,
        get,
        conversationId,
        turnId,
        tier: 'auto',
        folders: [],
        expandedMessages: [
          { id: 'user-reference', turnId, role: 'user', content: 'Create it.', createdAt: 1 },
        ],
        currentUserMessageId: 'user-reference',
        stagedReferenceIds: [],
        allowedExistingReferenceIds: [],
        workspaceScope: null,
        isWorkspaceScopeCurrent: () => true,
        workspacePath: '/qualification-workspace',
        controller: new AbortController(),
        queueTerminalMessage: vi.fn(),
        queueProposedEntityReference: vi.fn(),
        queueMaterializedEntityReference: vi.fn(),
        finishTurn: vi.fn(),
      };

      await expect(executeHostedCodexTurn(options)).resolves.toBe('completed');

      expect(getEntityReferencesByIds).toHaveBeenCalledWith([referenceId]);
      expect(options.queueMaterializedEntityReference).toHaveBeenCalledWith(reference);
      expect(store._convStates.get(conversationId)?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            toolName,
            content: expect.stringContaining(`\"id\":\"${referenceId}\"`),
          }),
        ])
      );
    }
  );

  it('keeps streamed assistant text when the terminal Hosted result is an error', async () => {
    const conversationId = 'conversation-1';
    const turnId = 'turn-1';
    let store = {
      _convStates: new Map([[conversationId, createEmptyConversationState()]]),
      currentConversationId: conversationId,
    } as unknown as ChatStore;
    const set: ChatStoreSet = (patch) => {
      const resolved = typeof patch === 'function' ? patch(store) : patch;
      store = { ...store, ...resolved };
    };
    const get: ChatStoreGet = () => store;

    const listeners = new Set<Parameters<HostedCodexBridge['onTurnEvent']>[0]>();
    const bridge: HostedCodexBridge = {
      prepareContribution: vi.fn(),
      cancelPreparedTurn: vi.fn(async () => ({ ok: true })),
      stopTurn: vi.fn(async () => ({ ok: true })),
      onTurnEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      startTurn: vi.fn(async (request) => {
        for (const listener of listeners) {
          listener({
            workflowId: request.workflowId,
            runId: request.runId,
            turnId: request.turnId,
            kind: 'text_delta',
            delta: 'I started a useful answer.',
          });
        }
        return {
          ok: false as const,
          code: 'provider_stream_failed' as const,
          message:
            'DNAForge AI could not finish.\nError code: RESPONSE_STREAM_DISCONNECTED\nReference ID: ABCD1234',
        };
      }),
    };

    const options: ExecuteHostedCodexTurnOptions = {
      bridge,
      set,
      get,
      conversationId,
      turnId,
      tier: 'auto',
      permissions: BUILT_IN_AGENT_PERMISSIONS,
      folders: [],
      expandedMessages: [
        { id: 'user-1', turnId, role: 'user', content: 'make a plasmid', createdAt: 1 },
      ],
      currentUserMessageId: 'user-1',
      stagedReferenceIds: [],
      allowedExistingReferenceIds: [],
      workspaceScope: null,
      isWorkspaceScopeCurrent: () => true,
      workspacePath: null,
      controller: new AbortController(),
      queueTerminalMessage: vi.fn(),
      queueProposedEntityReference: vi.fn(),
      queueMaterializedEntityReference: vi.fn(),
      finishTurn: vi.fn(),
    };

    await expect(executeHostedCodexTurn(options)).rejects.toMatchObject({
      name: HostedCodexTurnExecutionError.name,
      code: 'provider_stream_failed',
    });
    const conversation = store._convStates.get(conversationId);
    expect(conversation?.messages).toMatchObject([
      { role: 'assistant', content: 'I started a useful answer.' },
    ]);
    expect(options.queueTerminalMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: 'I started a useful answer.' }),
      []
    );
  });
});
