import { describe, expect, it, vi } from 'vitest';

import { browserMockBridge, getBrowserMockApiUrl } from './browser-mock';
import { MockFsModule } from '../test/platform-mocks';
import type {
  CommitChatTurnTerminalStateRequest,
  CreateChatTurnWithUserMessageRequest,
} from '../shared/chat-turn-ipc';

describe('browserMockBridge API URL', () => {
  it('keeps desktop included allowance unavailable without inventing a balance', async () => {
    await expect(browserMockBridge.hostedAi.readIncludedAllowance()).resolves.toEqual({
      status: 'unavailable',
      code: 'not_configured',
    });
  });

  it('preserves the browser text source and enforces UTF-8 bytes for a bounded admitted read', async () => {
    const readText = vi.spyOn(MockFsModule, 'readTextFile').mockResolvedValue('λ');
    try {
      const request = {
        path: '/external/selected.json',
        projectRoots: [],
        grantedFiles: ['/external/selected.json'],
      };
      await expect(
        browserMockBridge.fs.readAdmittedTextFile({ ...request, maxBytes: 2 })
      ).resolves.toBe('λ');
      await expect(
        browserMockBridge.fs.readAdmittedTextFile({ ...request, maxBytes: 1 })
      ).rejects.toThrow('File exceeds 1 bytes');
      await expect(
        browserMockBridge.fs.readAdmittedTextFile({ ...request, grantedFiles: [], maxBytes: 2 })
      ).rejects.toThrow('Path access denied');
    } finally {
      readText.mockRestore();
    }
  });
  it('uses VITE_API_URL when the browser renderer has a configured sidecar URL', () => {
    expect(getBrowserMockApiUrl({ VITE_API_URL: 'http://configured-sidecar.test.invalid' })).toBe(
      'http://configured-sidecar.test.invalid'
    );
  });

  it('falls back to an invalid test URL when no Vite env URL exists', () => {
    expect(getBrowserMockApiUrl({})).toBe('http://browser-mock-sidecar.test.invalid');
  });

  it('reports explicit browser-mock provenance instead of pretending to be Electron', async () => {
    const provenance = await browserMockBridge.runtime.getProvenance();

    expect(provenance.kind).toBe('browser-mock');
    expect(provenance.isPackaged).toBe(false);
    expect(provenance.userDataPath).toBeNull();
    expect(provenance.cacheContractToken).toBeNull();
  });

  it('keeps every multi-record Quick Look destination in browser parity', async () => {
    const result = await browserMockBridge.fileAssociations.promoteQuickLookPackage({
      receipt: {
        sourcePath: '/Downloads/assembly.gbk',
        sourceFileName: 'assembly.gbk',
        familyId: 'genbank',
        contentHash: 'a'.repeat(64),
        packageRoot: '/browser-quick-look/assembly.gbk',
        productPath: '/browser-quick-look/assembly.gbk/first.gb',
        records: [
          {
            recordId: 'b'.repeat(64),
            ordinal: 0,
            displayName: 'first',
            sequenceLength: 4,
            circular: false,
            productPath: '/browser-quick-look/assembly.gbk/first.gb',
          },
          {
            recordId: 'c'.repeat(64),
            ordinal: 1,
            displayName: 'second',
            sequenceLength: 6,
            circular: false,
            productPath: '/browser-quick-look/assembly.gbk/second.gb',
          },
        ],
      },
      destination: { kind: 'existing-workspace', rootPath: '/workspace' },
    });

    expect(result.records).toEqual([
      {
        recordId: 'b'.repeat(64),
        destPath: '/workspace/assembly/first/first.gb',
        relPath: 'assembly/first/first.gb',
      },
      {
        recordId: 'c'.repeat(64),
        destPath: '/workspace/assembly/second/second.gb',
        relPath: 'assembly/second/second.gb',
      },
    ]);
  });

  it('persists mock keyring values so browser-mode E2E can configure Direct API', async () => {
    await browserMockBridge.keyring.setPassword('dnaforge', 'anthropic_api_key', 'sk-test');

    await expect(
      browserMockBridge.keyring.getPassword('dnaforge', 'anthropic_api_key')
    ).resolves.toBe('sk-test');

    await browserMockBridge.keyring.deletePassword('dnaforge', 'anthropic_api_key');
    await expect(
      browserMockBridge.keyring.getPassword('dnaforge', 'anthropic_api_key')
    ).resolves.toBeNull();
  });

  it('hasPassword mirrors presence without returning the value ', async () => {
    await expect(browserMockBridge.keyring.hasPassword('dnaforge', 'openai_api_key')).resolves.toBe(
      false
    );

    await browserMockBridge.keyring.setPassword('dnaforge', 'openai_api_key', 'sk-mock');
    await expect(browserMockBridge.keyring.hasPassword('dnaforge', 'openai_api_key')).resolves.toBe(
      true
    );

    await browserMockBridge.keyring.deletePassword('dnaforge', 'openai_api_key');
    await expect(browserMockBridge.keyring.hasPassword('dnaforge', 'openai_api_key')).resolves.toBe(
      false
    );
  });

  it('round-trips immutable reference origins through the browser terminal-commit adapter', async () => {
    const suffix = crypto.randomUUID();
    const conversationId = `browser-origin-conversation-${suffix}`;
    const turnId = `browser-origin-turn-${suffix}`;
    const referenceId = `browser-origin-reference-${suffix}`;
    await browserMockBridge.db.execute(
      `INSERT INTO conversations (id, title, workspace_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [conversationId, 'Origin parity', '/workspace/original', 1, 1]
    );
    const start = {
      turn: {
        id: turnId,
        conversation_id: conversationId,
        route_kind: 'hosted',
        host_id: 'browser-test',
        provider: 'anthropic',
        model: 'test-model',
        transport: 'hosted',
        authority_profile_id: null,
        permission_mode: null,
        route_snapshot_json: '{}',
        status: 'running',
        terminal_reason: null,
        error: null,
        started_at: 1,
        completed_at: null,
      },
      message: {
        id: `browser-origin-user-${suffix}`,
        conversation_id: conversationId,
        turn_id: turnId,
        role: 'user',
        content: 'Open pUC19',
        tool_name: null,
        tool_call_id: null,
        created_at: 1,
      },
    } satisfies CreateChatTurnWithUserMessageRequest;
    await browserMockBridge.db.createChatTurnWithUserMessage(start);

    const terminal = {
      turn_id: turnId,
      conversation_id: conversationId,
      status: 'completed',
      terminal_reason: 'completed',
      error: null,
      completed_at: 2,
      proposed_entity_references: [
        {
          id: referenceId,
          entity_type: 'sequence',
          display_label: 'pUC19',
          locator: 'git://My Workspace/pUC19.gb',
          deep_link_params: null,
          data: null,
          source: 'ai',
          status: 'created',
          workspace_scope: 'folders:["/workspace/original"]',
          workspace_root_path: '/workspace/original',
          created_at: 2,
          updated_at: 2,
        },
      ],
      messages: [
        {
          message: {
            id: `browser-origin-assistant-${suffix}`,
            conversation_id: conversationId,
            turn_id: turnId,
            role: 'assistant',
            content: 'pUC19',
            tool_name: null,
            tool_call_id: null,
            created_at: 2,
          },
          reference_ids: [referenceId],
        },
      ],
    } satisfies CommitChatTurnTerminalStateRequest;
    await expect(browserMockBridge.db.commitChatTurnTerminalState(terminal)).resolves.toEqual({
      committed: true,
    });

    await expect(
      browserMockBridge.db.select<Array<{ workspace_root_path: string | null }>>(
        'SELECT workspace_root_path FROM entity_references WHERE id = ?',
        [referenceId]
      )
    ).resolves.toEqual([expect.objectContaining({ workspace_root_path: '/workspace/original' })]);
  });

  it('exposes the workspace-scoped auto-sync contract in browser mode', async () => {
    await expect(browserMockBridge.cloudSync.getStatus('repo-uuid-a')).resolves.toMatchObject({
      workspaceUuid: 'repo-uuid-a',
      syncAxis: 'local_only',
      canDisplayPlainSynced: false,
    });

    const events: unknown[] = [];
    const unsubscribe = browserMockBridge.cloudSync.subscribeStatus('repo-uuid-a', (event) => {
      events.push(event);
    });
    unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workspaceUuid: 'repo-uuid-a',
      reason: 'subscribe',
    });

    await expect(browserMockBridge.cloudSync.forceSync('repo-uuid-a')).resolves.toMatchObject({
      ok: false,
      code: 'NOT_IMPLEMENTED',
    });
    await expect(browserMockBridge.cloudSync.forceSync('/tmp/workspace')).rejects.toThrow(
      'workspaceUuid must be a workspace UUID'
    );
  });
});
