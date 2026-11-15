import { beforeEach, describe, expect, it, vi } from 'vitest';

const privateProteinRenderer = vi.hoisted(() => vi.fn());
vi.mock('../../protein-experiment-workers', () => ({
  proteinExperimentRendererForTurn: privateProteinRenderer,
}));

vi.mock('../../agent-sdk/agent-permission-catalog', async () => ({
  readAgentPermissionCatalog: async () =>
    (await import('../../../shared/agent-permissions')).BUILT_IN_AGENT_PERMISSION_CATALOG,
}));

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: {
    getPath: vi.fn((name: string) => `/tmp/dnaforge-agent-session-${process.pid}-${name}`),
    getVersion: vi.fn(() => '1.0.0'),
    isPackaged: false,
  },
}));

vi.mock('../../analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../agent-capabilities/runtime-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-capabilities/runtime-service')>();
  return {
    ...actual,
    resolveRuntimeAutomaticSkillInstructions: vi.fn(async () => ({
      additionalInstructions: null,
      enabledNativeSkillIds: [],
      disabledNativeSkillIds: [],
      portableSkills: [],
    })),
  };
});

import { ensureSchema } from '../../schema';
import { createTestDb } from '../../__tests__/test-db';
import { AgentSessionManager } from '../manager';
import { publicAgentTraceDisplay } from '../../../shared/agent-trace-display';
import { userMessage } from '@waypoint/user-messages';
import { CodexTraceAdapter } from '../../agent-sdk/trace-adapter';
import type { AgentProvider, ProviderCapabilityReport } from '../types';
import type { CliMcpBridgeConfig } from '../../agent-sdk/cli-mcp';
import { createReadyCliMcpBridgeProvider } from '../../agent-sdk/cli-mcp-provider';
import { SidecarSessionAuthority } from '../../sidecar-session-authority';
import type { QueryOptions } from '../../agent-sdk/query';
import type { ConversationLedgerAppendInput } from '../../conversation-ledger';
import {
  __resetWorkspaceProvenanceForTests,
  recordCompletedToolCall,
} from '../../agent-sdk/turn-workspace-provenance';

const TEST_CLI_MCP_API_URL = 'http://agent-session-sidecar.test.invalid';

function capability(provider: AgentProvider): ProviderCapabilityReport {
  const isCodex = provider === 'codex-sdk';
  const isGrok = provider === 'grok-acp';
  return {
    provider,
    auth: 'authenticated',
    versions: {
      sdkVersion: isCodex ? '0.133.0' : isGrok ? '1.4.0' : '0.3.150',
      cliVersion: isCodex ? 'codex 0.136.0' : isGrok ? 'grok 1.0.13' : 'claude 2.1.161',
      binaryPath: isCodex
        ? '/usr/local/bin/codex'
        : isGrok
          ? '/usr/local/bin/grok'
          : '/usr/local/bin/claude',
    },
    activity: {
      publicReasoningSummary: { status: 'supported', evidence: 'static_probe', notes: [] },
      commandEvents: { status: 'supported', evidence: 'static_probe', notes: [] },
      fileEvents: { status: 'supported', evidence: 'static_probe', notes: [] },
      permissionEvents: { status: 'unknown', evidence: 'unverified', notes: [] },
      unknownEventFallback: 'required',
    },
    cancellation: {
      modelStop: { status: 'supported', evidence: 'static_probe', notes: [] },
      activeToolStop: 'stop_requested_only',
      childReaping: { status: 'unsupported', evidence: 'static_probe', notes: [] },
    },
    workspace: {
      cwd: { supported: true, evidence: 'declared', notes: [] },
      additionalRoots: { supported: false, evidence: 'declared', notes: [] },
      providerSandboxModes: ['read-only', 'workspace-write'],
    },
    mcp: {
      stdioServer: { supported: true, evidence: 'declared', notes: [] },
      toolAllowlist: { supported: true, evidence: 'declared', notes: [] },
      perTurnCorrelation: { supported: true, evidence: 'declared', notes: [] },
    },
  };
}

function bridge(): CliMcpBridgeConfig {
  return {
    apiUrl: TEST_CLI_MCP_API_URL,
    sessionToken: 'session-token',
    agentIdentityId: 'local-in-app-chat',
    capabilities: ['read-workspace'],
    command: '/Applications/DNAForge.app/Contents/Resources/binaries/waypoint-api',
    commandArgs: ['--mcp-stdio'],
  };
}

function insertRunningTurn(
  db: ReturnType<typeof createTestDb>,
  turnId: string,
  provider: 'codex-sdk' | 'claude-agent-sdk'
): void {
  const conversationId = `conversation_${turnId}`;
  const authorityProfileId =
    provider === 'codex-sdk' ? 'codex-sdk:app-supervised' : 'claude-agent-sdk:app-supervised';
  db.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at, provider, model)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(conversationId, 'Grounding test', 1, 1, provider, provider);
  db.prepare(
    `INSERT INTO chat_turns (
      id, conversation_id, route_kind, host_id, provider, model, transport,
      authority_profile_id, permission_mode, route_snapshot_json, status, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    turnId,
    conversationId,
    'cli',
    provider === 'codex-sdk' ? 'codex-cli' : 'claude-cli',
    null,
    null,
    provider,
    authorityProfileId,
    'app-supervised',
    JSON.stringify({ kind: 'cli', transport: provider, permissionMode: 'app-supervised' }),
    'running',
    1
  );
}

function markTurnStartedAfterManagerRecovery(
  db: ReturnType<typeof createTestDb>,
  turnId: string
): void {
  db.prepare(
    `UPDATE chat_turns
     SET status = 'running', terminal_reason = NULL, completed_at = NULL
     WHERE id = ?`
  ).run(turnId);
}

describe('AgentSessionManager', () => {
  beforeEach(() => {
    privateProteinRenderer.mockReturnValue(undefined);
    __resetWorkspaceProvenanceForTests();
  });

  it.each(['ready', 'user-stop', 'service-stop'] as const)(
    'settles a tool-bearing session waiting for startup after %s',
    async (outcome) => {
      const db = createTestDb();
      ensureSchema(db, ':memory:');
      const authority = new SidecarSessionAuthority();
      const spawn = authority.prepareManagedSpawn('initial');
      const provide = createReadyCliMcpBridgeProvider(authority, (snapshot) => ({
        ...bridge(),
        sessionToken: snapshot.token,
      }));
      let entered: () => void = () => {};
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const queryCodex = vi.fn(async () => ({
        ok: true,
        text: 'done',
        durationMs: 1,
        stopState: 'completed' as const,
      }));
      const logFailure = vi.fn();
      const manager = new AgentSessionManager({
        db,
        releaseChannel: 'development',
        describeCapabilities: async (provider) => capability(provider),
        cliMcpBridgeProvider: (signal) => {
          entered();
          return provide(signal);
        },
        queryCodex,
        logFailure,
        cancelRendererToolCallsForTurn: () => 0,
      });
      try {
        const run = manager.startSession({
          sessionId: `startup_${outcome}`,
          provider: 'codex-sdk',
          authorityProfileId: 'codex-sdk:app-supervised',
          prompt: 'use workspace tools',
          cwd: '/workspace',
          workspaceGrounding: 'not-required',
        });
        await waiting;
        expect(manager.getSession(`startup_${outcome}`)?.status).toBe('running');
        expect(queryCodex).not.toHaveBeenCalled();
        if (outcome === 'ready') authority.markReady(spawn.generation);
        if (outcome === 'user-stop') manager.requestStop(`startup_${outcome}`);
        if (outcome === 'service-stop') authority.markStopped();
        const expectedState =
          outcome === 'ready' ? 'completed' : outcome === 'user-stop' ? 'stop_requested' : 'failed';
        await expect(run).resolves.toMatchObject({
          ok: outcome === 'ready',
          stopState: expectedState,
        });
        expect(manager.getSession(`startup_${outcome}`)?.status).toBe(
          outcome === 'user-stop' ? 'stop_unconfirmed' : expectedState
        );
        expect(manager.requestStop(`startup_${outcome}`)).toMatchObject({
          cancelled: false,
          state: 'not_found',
        });
        authority.markReady(spawn.generation);
        await Promise.resolve();
        expect(queryCodex).toHaveBeenCalledTimes(outcome === 'ready' ? 1 : 0);
        if (outcome === 'ready') {
          expect(queryCodex).toHaveBeenCalledWith(
            'use workspace tools',
            expect.objectContaining({
              cliMcpBridge: expect.objectContaining({ sessionToken: spawn.token }),
            })
          );
        }
        expect(logFailure).toHaveBeenCalledTimes(outcome === 'service-stop' ? 1 : 0);
      } finally {
        authority.markStopped();
        db.close();
      }
    }
  );

  it('does not acquire MCP authority for an explicit tool-free auxiliary session', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const provide = vi.fn(() => {
      throw new Error('Auxiliary turn acquired MCP authority');
    });
    const queryCodex = vi.fn(async () => ({ ok: true, text: 'title', durationMs: 1 }));
    const manager = new AgentSessionManager({
      db,
      describeCapabilities: async (provider) => capability(provider),
      cliMcpBridgeProvider: provide,
      queryCodex,
    });
    try {
      await expect(
        manager.startSession({
          sessionId: 'startup_auxiliary',
          provider: 'codex-sdk',
          authorityProfileId: 'codex-sdk:app-supervised',
          prompt: 'name the conversation',
          cwd: '/workspace',
          workspaceGrounding: 'not-required',
          toolExposure: 'none',
        })
      ).resolves.toMatchObject({ ok: true, lastTraceSequence: -1 });
      expect(provide).not.toHaveBeenCalled();
      expect(queryCodex).toHaveBeenCalledWith(
        'name the conversation',
        expect.objectContaining({
          cliMcpBridge: null,
        })
      );
    } finally {
      db.close();
    }
  });

  it('derives fresh author isolation from the private main binding without automatic skills or resume', async () => {
    privateProteinRenderer.mockImplementation((turnId) =>
      turnId === 'fresh-author' ? {} : undefined
    );
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const resolveAutomaticSkillInstructions = vi.fn();
    const queryCodex = vi.fn(async (_prompt: string, options: QueryOptions) => {
      expect(options.molecularTrialAuthor).toBe(true);
      expect(options.runtimeAgentInstructions).toBeUndefined();
      expect(options.providerConversationId).toBeUndefined();
      return { ok: true, text: 'done', durationMs: 1, stopState: 'completed' as const };
    });
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      queryCodex,
      describeCapabilities: async (provider) => capability(provider),
      resolveAutomaticSkillInstructions,
      resolveScratchCwd: async () => '/scratch/fresh-author',
    });
    await expect(
      manager.startSession({
        sessionId: 'fresh-author',
        conversationId: null,
        turnId: null,
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:native-workspace-write-dev',
        prompt: 'fixed question',
        continuationPrompt: 'fixed question',
        cwd: null,
        workspaceGrounding: 'not-required',
      })
    ).resolves.toMatchObject({ ok: true });
    expect(resolveAutomaticSkillInstructions).not.toHaveBeenCalled();
  });

  it('launches a validated custom executable even when the built-in CLI is absent', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const queryCodex = vi.fn(async (_prompt: string, options: QueryOptions) => {
      expect(options.binaryPathOverride).toBe('/opt/lab/bin/codex');
      return { ok: true, text: 'done', durationMs: 1, stopState: 'completed' as const };
    });
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      describeCapabilities: async (provider) => ({
        ...capability(provider),
        auth: 'missing',
        versions: { sdkVersion: null, cliVersion: null, binaryPath: null },
      }),
      queryCodex,
    });

    await expect(
      manager.startSession({
        sessionId: 'custom-harness-session',
        conversationId: null,
        turnId: null,
        provider: 'codex-sdk',
        binaryPathOverride: '/opt/lab/bin/codex',
        authorityProfileId: 'codex-sdk:native-workspace-write-dev',
        prompt: 'hello',
        cwd: '/workspace',
        workspaceGrounding: 'not-required',
      })
    ).resolves.toMatchObject({ ok: true, text: 'done' });
    expect(queryCodex).toHaveBeenCalledOnce();
  });

  it('rejects a turn that does not belong to the supplied conversation before provider launch', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, provider, model)
       VALUES
         ('conversation-a', 'Conversation A', 1, 1, 'codex-sdk', 'codex-sdk'),
         ('conversation-b', 'Conversation B', 1, 1, 'codex-sdk', 'codex-sdk')`
    ).run();
    db.prepare(
      `INSERT INTO chat_turns (
        id, conversation_id, route_kind, host_id, transport, authority_profile_id,
        permission_mode, route_snapshot_json, status, started_at
      ) VALUES ('turn-b', 'conversation-b', 'cli', 'codex-cli', 'codex-sdk',
        'codex-sdk:app-supervised', 'app-supervised', '{}', 'running', 1)`
    ).run();
    const queryCodex = vi.fn(async () => ({
      ok: true,
      text: 'must not run',
      durationMs: 1,
      stopState: 'completed' as const,
    }));
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      describeCapabilities: async (provider) => capability(provider),
      queryCodex,
    });

    await expect(
      manager.startSession({
        sessionId: 'session-crossed',
        conversationId: 'conversation-a',
        turnId: 'turn-b',
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:app-supervised',
        prompt: 'Do not launch this crossed session',
        cwd: '/workspace',
        workspaceGrounding: 'not-required',
      })
    ).rejects.toThrow(/turn-b.*conversation-a|conversation-a.*turn-b/i);

    expect(queryCodex).not.toHaveBeenCalled();
    expect(manager.getSession('session-crossed')).toBeNull();
  });

  it.each(['codex-sdk', 'claude-agent-sdk', 'grok-acp'] as const)(
    'gives %s the automatic skill index without a manual capability selection',
    async (provider) => {
      const db = createTestDb();
      ensureSchema(db, ':memory:');
      const automaticInstructions =
        'Available DNAForge skills: primer-review at /skills/primer-review/SKILL.md';
      const resolveAutomaticSkillInstructions = vi.fn(async () => ({
        additionalInstructions: automaticInstructions,
        enabledNativeSkillIds: ['native-primer-review'],
        disabledNativeSkillIds: ['native-old-review'],
        portableSkills: [
          { name: 'primer-review', sourcePath: '/app/skills/primer-review/SKILL.md' },
        ],
      }));
      const query = vi.fn(async (_prompt: string, options: QueryOptions) => {
        expect(options.additionalAgentInstructions).toBeUndefined();
        expect(options.runtimeAgentInstructions).toContain(automaticInstructions);
        expect(options.enabledNativeSkillIds).toEqual(['native-primer-review']);
        expect(options.disabledNativeSkillIds).toEqual(['native-old-review']);
        expect(options.portableSkills).toEqual([
          { name: 'primer-review', sourcePath: '/app/skills/primer-review/SKILL.md' },
        ]);
        expect(options.selectedCapability).toBeNull();
        return { ok: true, text: 'done', durationMs: 1, stopState: 'completed' as const };
      });
      const manager = new AgentSessionManager({
        db,
        releaseChannel: 'development',
        describeCapabilities: async (candidate) => capability(candidate),
        resolveAutomaticSkillInstructions,
        queryCodex: query,
        queryClaudeCode: query,
        queryGrok: query,
      });

      await expect(
        manager.startSession({
          sessionId: `automatic-skills-${provider}`,
          conversationId: null,
          turnId: null,
          provider,
          authorityProfileId:
            provider === 'codex-sdk'
              ? 'codex-sdk:app-supervised'
              : provider === 'claude-agent-sdk'
                ? 'claude-agent-sdk:app-supervised'
                : 'grok-acp:native-workspace-write',
          prompt: 'Review this primer pair.',
          cwd: '/workspace',
          workspaceGrounding: 'not-required',
        })
      ).resolves.toMatchObject({ ok: true, text: 'done' });

      expect(resolveAutomaticSkillInstructions).toHaveBeenCalledWith({
        provider,
        workspacePath: '/workspace',
      });
      expect(query).toHaveBeenCalledOnce();
    }
  );

  it('starts a concrete authority session and persists provider trace rows', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, provider, model)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('conv-1', 'Session test', 1, 1, 'codex-sdk', 'codex-sdk');
    db.prepare(
      `INSERT INTO chat_turns (
        id, conversation_id, route_kind, host_id, provider, model, transport,
        authority_profile_id, permission_mode, route_snapshot_json, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-1',
      'conv-1',
      'cli',
      'codex-cli',
      null,
      null,
      'codex-sdk',
      'codex-sdk:app-supervised',
      'app-supervised',
      '{"kind":"cli","transport":"codex-sdk","permissionMode":"app-supervised"}',
      'running',
      1
    );

    const events: unknown[] = [];
    const shadowLedgerEvents: ConversationLedgerAppendInput[] = [];
    const requestUserInput = vi.fn();
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      cliMcpBridgeProvider: bridge,
      describeCapabilities: async (provider) => capability(provider),
      requestUserInputProvider: () => requestUserInput,
      resolveChatReach: async ({ conversationId, roots }) => {
        expect(conversationId).toBe('conv-1');
        expect(roots).toEqual([
          { path: '/workspace/other', name: 'Other' },
          { path: '/workspace', name: 'workspace' },
        ]);
        return {
          cwd: '/chats/conv-1',
          writableRoots: ['/workspace/other', '/workspace'],
          shortcuts: [
            { name: 'Other', path: '/workspace/other' },
            { name: 'workspace', path: '/workspace' },
          ],
        };
      },
      queryCodex: async (prompt, options) => {
        expect(prompt).toBe('inspect workspace');
        expect(options.runtimeAgentInstructions).toContain('`Other/`');
        expect(options).toMatchObject({
          purpose: 'chat',
          cwd: '/chats/conv-1',
          writableRoots: ['/workspace/other', '/workspace'],
          queryId: 'session_1',
          conversationId: 'conv-1',
          turnId: 'session_1',
          permissionMode: 'app-supervised',
          model: 'gpt-5-codex',
          modelReasoningEffort: 'high',
          shellSupervision: 'destructive-only',
          cliMcpBridge: bridge(),
          requestUserInput,
        });
        options.traceSink?.({
          transport: 'codex-sdk',
          sequence: 0,
          receivedAt: '2026-06-03T00:00:00.000Z',
          providerEventType: 'item.completed',
          providerItemType: 'reasoning',
          raw: { type: 'item.completed' },
          display: publicAgentTraceDisplay({
            kind: 'reasoning',
            title: 'Thinking',
            text: 'checked workspace',
          }),
          versions: { sdkVersion: null, cliVersion: null },
        });
        return { ok: true, text: 'done', durationMs: 12, stopState: 'completed' };
      },
      eventSink: (event) => events.push(event),
      appendShadowLedgerEvent: (event) => {
        shadowLedgerEvents.push(event);
      },
    });
    markTurnStartedAfterManagerRecovery(db, 'turn-1');

    await expect(
      manager.startSession({
        sessionId: 'session_1',
        conversationId: 'conv-1',
        turnId: 'turn-1',
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:app-supervised',
        prompt: 'inspect workspace',
        cwd: '/workspace',
        reachRoots: [{ path: '/workspace/other', name: 'Other' }],
        workspaceGrounding: 'not-required',
        shellSupervision: 'destructive-only',
        model: 'gpt-5-codex',
        modelReasoningEffort: 'high',
      })
    ).resolves.toMatchObject({
      ok: true,
      sessionId: 'session_1',
      provider: 'codex-sdk',
      authorityProfileId: 'codex-sdk:app-supervised',
      text: 'done',
      stopState: 'completed',
      lastTraceSequence: 0,
    });

    expect(events).toEqual([
      expect.objectContaining({
        sessionId: 'session_1',
        type: 'trace',
        event: expect.objectContaining({ providerEventType: 'item.completed' }),
      }),
    ]);
    expect(manager.getSession('session_1')).toMatchObject({
      id: 'session_1',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      status: 'completed',
      authorityProfileId: 'codex-sdk:app-supervised',
      permissionModeLabel: 'app-supervised',
      cwd: '/chats/conv-1',
    });
    expect(
      db.prepare('SELECT event_type, provider, terminal FROM agent_trace_events').all()
    ).toEqual([{ event_type: 'item.completed', provider: 'codex-sdk', terminal: null }]);
    expect(shadowLedgerEvents).toEqual([
      expect.objectContaining({
        conversation_id: 'conv-1',
        turn_id: 'turn-1',
        source: 'cli:codex',
        provider: 'codex-sdk',
        model: 'gpt-5-codex',
        stream_event_type: 'item.completed',
        payload: expect.objectContaining({
          providerEventType: 'item.completed',
          sequence: 0,
        }),
      }),
    ]);
  });

  it('projects an immutable attachment snapshot into the exact provider prompt without truncation', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const tail = 'ATTACHMENT_TAIL_SENTINEL';
    const attachmentText = `--- Attached file: long.txt ---\n${'A'.repeat(12_000)}${tail}\n--- End attached file: long.txt ---`;
    const queryCodex = vi.fn(async (prompt: string) => {
      expect(prompt).toBe(`Analyze this file.\n\n${attachmentText}`);
      expect(prompt).not.toContain('...(truncated)');
      return { ok: true, text: 'done', durationMs: 1, stopState: 'completed' as const };
    });
    const resolveAttachmentText = vi.fn(async () => attachmentText);
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      describeCapabilities: async (provider) => capability(provider),
      resolveAttachmentText,
      queryCodex,
    });
    const sha256 = 'a'.repeat(64);

    await manager.startSession({
      sessionId: 'session_attachment',
      provider: 'codex-sdk',
      authorityProfileId: 'codex-sdk:app-supervised',
      prompt: 'Analyze this file.',
      cwd: '/workspace',
      workspaceGrounding: 'not-required',
      attachments: [
        {
          id: `attachment-${sha256}`,
          sha256,
          name: 'long.txt',
          kind: 'text',
          mediaType: 'text/plain',
          size: 12_024,
        },
      ],
    });

    expect(resolveAttachmentText).toHaveBeenCalledOnce();
    expect(queryCodex).toHaveBeenCalledOnce();
  });

  it('persists and returns the exact validated structured result for a selected turn control', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    insertRunningTurn(db, 'turn_structured', 'codex-sdk');
    const rawResult = '{"answer":42,"units":"bp"}';
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      describeCapabilities: async (provider) => capability(provider),
      resolveCapabilityInstructions: async () => ({
        additionalInstructions: 'Return exactly one JSON object.',
        control: {
          id: 'codex-sdk:structured-output:json-object',
          provider: 'codex-sdk',
          nativeId: 'json-object',
          kind: 'structured-output',
          label: 'Structured JSON object',
          description: 'Return one JSON object.',
          scope: 'conversation',
          effects: ['instructions'],
          availability: { state: 'supported' },
          stages: {
            advertised: true,
            discoverable: true,
            invocable: true,
            visible: true,
            deterministic: true,
            liveQualified: false,
          },
          source: 'dnaforge-structured-output:json-object',
        },
      }),
      queryCodex: async (_prompt, options) => {
        expect(options.runtimeAgentInstructions).toContain('exactly one JSON object');
        return { ok: true, text: rawResult, durationMs: 1, stopState: 'completed' };
      },
    });
    markTurnStartedAfterManagerRecovery(db, 'turn_structured');

    const result = await manager.startSession({
      sessionId: 'session_structured',
      conversationId: 'conversation_turn_structured',
      turnId: 'turn_structured',
      provider: 'codex-sdk',
      authorityProfileId: 'codex-sdk:app-supervised',
      prompt: 'Return the answer.',
      cwd: '/workspace',
      workspaceGrounding: 'not-required',
      capabilitySelection: {
        snapshotId: 'snapshot-structured',
        provider: 'codex-sdk',
        capabilityId: 'codex-sdk:structured-output:json-object',
      },
    });

    expect(result.structuredOutput).toMatchObject({
      turnId: 'turn_structured',
      rawResult,
      status: 'valid',
      parsed: { answer: 42, units: 'bp' },
      artifactId: expect.stringMatching(/^structured-sha256-[a-f0-9]{64}$/),
    });
    expect(
      db
        .prepare(
          `SELECT raw_result, validation_status, artifact_id
         FROM agent_structured_outputs WHERE turn_id = 'turn_structured'`
        )
        .get()
    ).toEqual({
      raw_result: rawResult,
      validation_status: 'valid',
      artifact_id: result.structuredOutput?.artifactId,
    });
  });

  it('routes a Grok session through the ACP executor with the native authority profile', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, provider, model)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('conv-grok', 'Grok session', 1, 1, 'grok-acp', 'grok-4.6');
    db.prepare(
      `INSERT INTO chat_turns (
        id, conversation_id, route_kind, host_id, provider, model, transport,
        authority_profile_id, permission_mode, route_snapshot_json, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-grok',
      'conv-grok',
      'cli',
      'grok-cli',
      null,
      'grok-4.6',
      'grok-acp',
      'grok-acp:native-workspace-write',
      'native-cli',
      '{"kind":"cli","transport":"grok-acp","permissionMode":"native-cli"}',
      'running',
      1
    );
    const requestUserInput = vi.fn();
    const queryGrok = vi.fn(async (_prompt: string, options: QueryOptions) => {
      expect(options).toMatchObject({
        purpose: 'chat',
        conversationId: 'conv-grok',
        queryId: 'session-grok',
        turnId: 'session-grok',
        permissionMode: 'native-cli',
        model: 'grok-4.6',
        cliMcpBridge: bridge(),
        requestUserInput,
      });
      return {
        transport: 'grok-acp' as const,
        ok: true,
        text: 'Grok completed the turn.',
        durationMs: 4,
        stopState: 'completed' as const,
        providerConversationId: 'grok-session-1',
      };
    });
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      cliMcpBridgeProvider: bridge,
      requestUserInputProvider: () => requestUserInput,
      describeCapabilities: async (provider) => capability(provider),
      queryGrok,
    });
    markTurnStartedAfterManagerRecovery(db, 'turn-grok');

    await expect(
      manager.startSession({
        sessionId: 'session-grok',
        conversationId: 'conv-grok',
        turnId: 'turn-grok',
        provider: 'grok-acp',
        authorityProfileId: 'grok-acp:native-workspace-write',
        prompt: 'Inspect the active workspace.',
        cwd: '/workspace',
        workspaceGrounding: 'not-required',
        model: 'grok-4.6',
      })
    ).resolves.toMatchObject({
      ok: true,
      provider: 'grok-acp',
      authorityProfileId: 'grok-acp:native-workspace-write',
      text: 'Grok completed the turn.',
      providerConversationId: 'grok-session-1',
    });
    expect(queryGrok).toHaveBeenCalledTimes(1);
  });

  it('tries the real Grok turn when the non-mutating auth probe is inconclusive', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const queryGrok = vi.fn(async () => ({
      transport: 'grok-acp' as const,
      ok: true,
      text: 'The stored Grok session is valid.',
      durationMs: 4,
      stopState: 'completed' as const,
    }));
    const unknownAuthCapabilities: ProviderCapabilityReport = {
      ...capability('grok-acp'),
      auth: 'unknown',
    };
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      describeCapabilities: async () => unknownAuthCapabilities,
      queryGrok,
    });

    await expect(
      manager.startSession({
        sessionId: 'session-grok-unknown-auth',
        conversationId: null,
        turnId: null,
        provider: 'grok-acp',
        authorityProfileId: 'grok-acp:native-workspace-write',
        prompt: 'Answer without tools.',
        cwd: '/workspace',
        workspaceGrounding: 'not-required',
        model: 'grok-4.5',
      })
    ).resolves.toMatchObject({
      ok: true,
      text: 'The stored Grok session is valid.',
    });
    expect(queryGrok).toHaveBeenCalledOnce();
  });

  it.each(['codex-sdk', 'claude-agent-sdk'] as const)(
    'preserves %s prose when no workspace tool was needed or called',
    async (provider) => {
      const db = createTestDb();
      ensureSchema(db, ':memory:');
      const turnId = `turn_ungrounded_${provider === 'codex-sdk' ? 'codex' : 'claude'}`;
      insertRunningTurn(db, turnId, provider);
      const emittedEvents: unknown[] = [];
      const ungroundedQuery = async (_prompt: string, options: QueryOptions) => {
        options.traceSink?.({
          transport: provider,
          sequence: 0,
          receivedAt: '2026-08-10T00:00:00.000Z',
          providerEventType: 'assistant.completed',
          providerItemType: 'agent_message',
          raw: { text: 'A plasmid is a DNA molecule.' },
          display: publicAgentTraceDisplay({
            kind: 'assistant_text',
            title: 'Assistant',
            text: 'A plasmid is a DNA molecule.',
          }),
          versions: { sdkVersion: null, cliVersion: null },
        });
        options.traceSink?.({
          transport: provider,
          sequence: 1,
          receivedAt: '2026-08-10T00:00:01.000Z',
          providerEventType: 'result',
          providerItemType: 'result',
          raw: { result: 'A plasmid is a DNA molecule.' },
          display: publicAgentTraceDisplay({
            kind: 'result',
            title: 'Turn completed',
            text: 'A plasmid is a DNA molecule.',
            visibility: 'diagnostic',
          }),
          versions: { sdkVersion: null, cliVersion: null },
        });
        return {
          ok: true,
          text: 'A plasmid is a DNA molecule.',
          durationMs: 4,
          stopState: 'completed' as const,
        };
      };
      const manager = new AgentSessionManager({
        db,
        releaseChannel: 'development',
        cliMcpBridgeProvider: bridge,
        describeCapabilities: async (candidate) => capability(candidate),
        queryCodex: ungroundedQuery,
        queryClaudeCode: ungroundedQuery,
        eventSink: (event) => emittedEvents.push(event),
      });
      markTurnStartedAfterManagerRecovery(db, turnId);

      const result = await manager.startSession({
        sessionId: `session_ungrounded_${provider === 'codex-sdk' ? 'codex' : 'claude'}`,
        turnId,
        provider,
        authorityProfileId:
          provider === 'codex-sdk' ? 'codex-sdk:app-supervised' : 'claude-agent-sdk:app-supervised',
        prompt: 'What is a plasmid?',
        cwd: '/workspace',
        workspaceGrounding: 'required',
      });

      expect(result).toMatchObject({
        ok: true,
        text: 'A plasmid is a DNA molecule.',
        stopState: 'completed',
        lastTraceSequence: 1,
        workspaceProvenance: {
          policy: 'required',
          grounded: false,
          completedWorkspaceTools: [],
        },
      });
      expect(result.error).toBeUndefined();
      expect(JSON.stringify(emittedEvents)).toContain('A plasmid is a DNA molecule.');
      expect(manager.getSession(result.sessionId)).toMatchObject({
        status: 'completed',
      });
    }
  );

  it('rejects a required tool workflow when the provider completes without a tool receipt', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    insertRunningTurn(db, 'turn_required_without_tool', 'codex-sdk');
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      cliMcpBridgeProvider: bridge,
      describeCapabilities: async (provider) => capability(provider),
      queryCodex: async (_prompt, options) => {
        expect(options.toolExposure).toBe('required');
        return { ok: true, text: 'Done.', durationMs: 1, stopState: 'completed' };
      },
    });
    markTurnStartedAfterManagerRecovery(db, 'turn_required_without_tool');

    await expect(
      manager.startSession({
        sessionId: 'session_required_without_tool',
        turnId: 'turn_required_without_tool',
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:app-supervised',
        prompt: 'Import this record.',
        cwd: '/workspace',
        workspaceGrounding: 'not-required',
        toolExposure: 'required',
      })
    ).resolves.toMatchObject({
      ok: false,
      text: 'Done.',
      stopState: 'failed',
      error: expect.stringContaining('required tool did not complete'),
    });
  });

  it('accepts a required tool workflow only after an exact completed app-tool receipt', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    insertRunningTurn(db, 'turn_required_with_tool', 'codex-sdk');
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      cliMcpBridgeProvider: bridge,
      describeCapabilities: async (provider) => capability(provider),
      queryCodex: async (_prompt, options) => {
        recordCompletedToolCall(options.turnId, 'highlight_range');
        return { ok: true, text: 'Highlighted.', durationMs: 1, stopState: 'completed' };
      },
    });
    markTurnStartedAfterManagerRecovery(db, 'turn_required_with_tool');

    await expect(
      manager.startSession({
        sessionId: 'session_required_with_tool',
        turnId: 'turn_required_with_tool',
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:app-supervised',
        prompt: 'Highlight this range.',
        cwd: '/workspace',
        workspaceGrounding: 'not-required',
        toolExposure: 'required',
      })
    ).resolves.toMatchObject({ ok: true, text: 'Highlighted.', stopState: 'completed' });
  });

  it.each(['codex-sdk', 'claude-agent-sdk'] as const)(
    'reports %s workspace provenance without delaying provider prose',
    async (provider) => {
      const db = createTestDb();
      ensureSchema(db, ':memory:');
      const turnId = `turn_grounded_${provider === 'codex-sdk' ? 'codex' : 'claude'}`;
      insertRunningTurn(db, turnId, provider);
      const emittedEvents: unknown[] = [];
      const query = async (_prompt: string, options: QueryOptions) => {
        options.traceSink?.({
          transport: provider,
          sequence: 0,
          receivedAt: '2026-08-10T00:00:00.000Z',
          providerEventType: 'assistant.completed',
          providerItemType: 'agent_message',
          raw: { text: 'I found guide.gb.' },
          display: publicAgentTraceDisplay({
            kind: 'assistant_text',
            title: 'Assistant',
            text: 'I found guide.gb.',
          }),
          versions: { sdkVersion: null, cliVersion: null },
        });
        options.traceSink?.({
          transport: provider,
          sequence: 1,
          receivedAt: '2026-08-10T00:00:01.000Z',
          providerEventType: 'tool.completed',
          providerItemType: 'mcp_tool_call',
          raw: { tool: 'list_files' },
          display: publicAgentTraceDisplay({
            kind: 'tool',
            title: 'list_files',
            status: 'completed',
          }),
          versions: { sdkVersion: null, cliVersion: null },
        });
        expect(
          emittedEvents.map(
            (envelope) =>
              (envelope as { event?: { providerEventType?: string } }).event?.providerEventType
          )
        ).toEqual(['assistant.completed', 'tool.completed']);
        recordCompletedToolCall(options.turnId, 'list_files');
        return {
          ok: true,
          text: 'I found guide.gb.',
          durationMs: 4,
          stopState: 'completed' as const,
        };
      };
      const manager = new AgentSessionManager({
        db,
        releaseChannel: 'development',
        cliMcpBridgeProvider: bridge,
        describeCapabilities: async (candidate) => capability(candidate),
        queryCodex: query,
        queryClaudeCode: query,
        eventSink: (event) => emittedEvents.push(event),
      });
      markTurnStartedAfterManagerRecovery(db, turnId);

      const result = await manager.startSession({
        sessionId: `session_grounded_${provider === 'codex-sdk' ? 'codex' : 'claude'}`,
        turnId,
        provider,
        authorityProfileId:
          provider === 'codex-sdk' ? 'codex-sdk:app-supervised' : 'claude-agent-sdk:app-supervised',
        prompt: 'find a sequence in my workspace that has a SpyCas9 gRNA',
        cwd: '/workspace',
        workspaceGrounding: 'required',
      });

      expect(result).toMatchObject({
        ok: true,
        text: 'I found guide.gb.',
        stopState: 'completed',
        workspaceProvenance: {
          policy: 'required',
          grounded: true,
          completedWorkspaceTools: ['list_files'],
        },
      });
      expect(
        emittedEvents.map(
          (envelope) =>
            (envelope as { event?: { providerEventType?: string } }).event?.providerEventType
        )
      ).toEqual(['assistant.completed', 'tool.completed']);
    }
  );

  it.each(['codex-sdk', 'claude-agent-sdk'] as const)(
    'permits a completed %s tool-only action without manufacturing provider prose',
    async (provider) => {
      const db = createTestDb();
      ensureSchema(db, ':memory:');
      const turnId = `turn_tool_only_${provider === 'codex-sdk' ? 'codex' : 'claude'}`;
      insertRunningTurn(db, turnId, provider);
      const emittedEvents: unknown[] = [];
      const query = async (_prompt: string, options: QueryOptions) => {
        options.traceSink?.({
          transport: provider,
          sequence: 0,
          receivedAt: '2026-08-19T00:00:00.000Z',
          providerEventType: 'tool.completed',
          providerItemType: 'mcp_tool_call',
          raw: { tool: 'create_reference' },
          display: publicAgentTraceDisplay({
            kind: 'tool',
            title: 'create_reference',
            status: 'completed',
          }),
          versions: { sdkVersion: null, cliVersion: null },
        });
        return {
          ok: true,
          text: '',
          durationMs: 4,
          stopState: 'completed' as const,
        };
      };
      const manager = new AgentSessionManager({
        db,
        releaseChannel: 'development',
        cliMcpBridgeProvider: bridge,
        describeCapabilities: async (candidate) => capability(candidate),
        queryCodex: query,
        queryClaudeCode: query,
        eventSink: (event) => emittedEvents.push(event),
      });
      markTurnStartedAfterManagerRecovery(db, turnId);

      const result = await manager.startSession({
        sessionId: `session_tool_only_${provider === 'codex-sdk' ? 'codex' : 'claude'}`,
        turnId,
        provider,
        authorityProfileId:
          provider === 'codex-sdk' ? 'codex-sdk:app-supervised' : 'claude-agent-sdk:app-supervised',
        prompt: 'create the requested reference',
        cwd: '/workspace',
        workspaceGrounding: 'required',
      });

      expect(result).toMatchObject({
        ok: true,
        text: '',
        stopState: 'completed',
        workspaceProvenance: {
          policy: 'required',
          grounded: false,
          completedWorkspaceTools: [],
        },
      });
      expect(manager.getSession(result.sessionId)).toMatchObject({ status: 'completed' });
      expect(
        emittedEvents.map(
          (envelope) =>
            (envelope as { event?: { providerEventType?: string } }).event?.providerEventType
        )
      ).toEqual(['tool.completed']);
    }
  );

  it('preserves partial provider text when an unrelated provider failure occurs', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    insertRunningTurn(db, 'turn_partial_failure', 'codex-sdk');
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      cliMcpBridgeProvider: bridge,
      describeCapabilities: async (candidate) => capability(candidate),
      queryCodex: async () => ({
        ok: false,
        text: 'Partial provider output',
        error: 'provider failed after streaming',
        durationMs: 4,
        stopState: 'failed',
      }),
    });
    markTurnStartedAfterManagerRecovery(db, 'turn_partial_failure');

    const result = await manager.startSession({
      sessionId: 'session_partial_failure',
      turnId: 'turn_partial_failure',
      provider: 'codex-sdk',
      authorityProfileId: 'codex-sdk:app-supervised',
      prompt: 'inspect my workspace',
      cwd: '/workspace',
      workspaceGrounding: 'required',
    });

    expect(result).toMatchObject({
      ok: false,
      text: 'Partial provider output',
      stopState: 'failed',
      workspaceProvenance: {
        policy: 'required',
        grounded: false,
        completedWorkspaceTools: [],
      },
    });
    expect(result.error).toContain('provider failed after streaming');
  });

  it('consumes a workspace receipt once so a reused turn id cannot inherit grounding', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    insertRunningTurn(db, 'turn_reused', 'codex-sdk');
    let callCount = 0;
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      cliMcpBridgeProvider: bridge,
      describeCapabilities: async (candidate) => capability(candidate),
      queryCodex: async (_prompt, options) => {
        callCount += 1;
        if (callCount === 1) recordCompletedToolCall(options.turnId, 'list_files');
        return { ok: true, text: 'answer', durationMs: 1, stopState: 'completed' };
      },
    });
    markTurnStartedAfterManagerRecovery(db, 'turn_reused');
    const request = {
      turnId: 'turn_reused',
      provider: 'codex-sdk' as const,
      authorityProfileId: 'codex-sdk:app-supervised',
      prompt: 'inspect my workspace',
      cwd: '/workspace',
      workspaceGrounding: 'required' as const,
    };

    await expect(
      manager.startSession({ ...request, sessionId: 'session_reused_1' })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      manager.startSession({ ...request, sessionId: 'session_reused_2' })
    ).resolves.toMatchObject({
      ok: true,
      workspaceProvenance: { grounded: false, completedWorkspaceTools: [] },
    });
  });

  it('rejects authority profiles whose runtime permission mapping is not implemented', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      describeCapabilities: async (provider) => capability(provider),
    });

    await expect(
      manager.startSession({
        sessionId: 'session_readonly',
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:native-read-only',
        prompt: 'read files',
        cwd: '/workspace',
        workspaceGrounding: 'not-required',
      })
    ).rejects.toThrow('runtime permission mapping is not implemented');
  });

  it('starts Claude Code standard CLI sessions with native CLI runtime options', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'production',
      cliMcpBridgeProvider: bridge,
      describeCapabilities: async (provider) => capability(provider),
      queryClaudeCode: async (prompt, options) => {
        expect(prompt).toBe('write a workspace note');
        expect(options).toMatchObject({
          purpose: 'chat',
          cwd: '/workspace',
          queryId: 'session_claude_native',
          turnId: 'session_claude_native',
          permissionMode: 'native-cli',
          cliMcpBridge: bridge(),
        });
        return { ok: true, text: 'done', durationMs: 9, stopState: 'completed' };
      },
    });

    await expect(
      manager.startSession({
        sessionId: 'session_claude_native',
        provider: 'claude-agent-sdk',
        authorityProfileId: 'claude-agent-sdk:native-workspace-write',
        prompt: 'write a workspace note',
        cwd: '/workspace',
        workspaceGrounding: 'not-required',
      })
    ).resolves.toMatchObject({
      ok: true,
      provider: 'claude-agent-sdk',
      authorityProfileId: 'claude-agent-sdk:native-workspace-write',
      stopState: 'completed',
    });
    expect(manager.getSession('session_claude_native')).toMatchObject({
      authorityClass: 'native-workspace-write',
      releaseMode: 'production',
      permissionModeLabel: 'native-cli',
      status: 'completed',
    });
  });

  it('separates active stopping from an unconfirmed terminal observation', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at, provider, model)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('conv-stop', 'Stop test', 1, 1, 'codex-sdk', 'codex-sdk');
    db.prepare(
      `INSERT INTO chat_turns (
        id, conversation_id, route_kind, host_id, provider, model, transport,
        authority_profile_id, permission_mode, route_snapshot_json, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'turn-stop',
      'conv-stop',
      'cli',
      'codex-cli',
      null,
      null,
      'codex-sdk',
      'codex-sdk:app-supervised',
      'app-supervised',
      '{"kind":"cli","transport":"codex-sdk","permissionMode":"app-supervised"}',
      'running',
      1
    );
    type StopResult = {
      ok: boolean;
      text: string;
      error: string;
      durationMs: number;
      stopState: 'stop_requested';
    };
    const queryState: {
      abort: AbortController | null;
      resolve: ((value: StopResult) => void) | null;
    } = { abort: null, resolve: null };
    const cancelRenderer = vi.fn(() => 1);
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      describeCapabilities: async (provider) => capability(provider),
      resolveChatReach: async () => ({ cwd: '/workspace', writableRoots: [], shortcuts: [] }),
      cancelRendererToolCallsForTurn: cancelRenderer,
      queryCodex: async (_prompt, options) => {
        queryState.abort = options.abortController ?? null;
        return new Promise((resolve) => {
          queryState.resolve = resolve;
        });
      },
    });
    markTurnStartedAfterManagerRecovery(db, 'turn-stop');

    const run = manager.startSession({
      sessionId: 'session_stop',
      conversationId: 'conv-stop',
      turnId: 'turn-stop',
      provider: 'codex-sdk',
      authorityProfileId: 'codex-sdk:app-supervised',
      prompt: 'long turn',
      cwd: '/workspace',
      workspaceGrounding: 'not-required',
    });

    await vi.waitFor(() => {
      expect(queryState.abort).toBeInstanceOf(AbortController);
    });

    expect(manager.requestStop('session_stop')).toEqual({
      ok: true,
      cancelled: true,
      state: 'stop_requested',
    });
    expect(cancelRenderer).toHaveBeenCalledWith('session_stop');
    expect(queryState.abort?.signal.aborted).toBe(true);
    expect(manager.getSession('session_stop')).toMatchObject({
      status: 'stopping',
      terminalReason: 'Stop requested.',
    });

    queryState.resolve?.({
      ok: false,
      text: '',
      error: 'Stop requested.',
      durationMs: 1,
      stopState: 'stop_requested',
    });

    await expect(run).resolves.toMatchObject({
      ok: false,
      stopState: 'stop_requested',
      error: 'Stop requested.',
    });
    expect(manager.getSession('session_stop')).toMatchObject({
      status: 'stop_unconfirmed',
      terminalReason: 'Stop requested.',
    });
  });

  it('remembers a stop requested while provider capabilities are still resolving', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    let capabilityLookupStarted: () => void = () => {};
    let releaseCapabilityLookup: () => void = () => {};
    const capabilityStarted = new Promise<void>((resolve) => {
      capabilityLookupStarted = resolve;
    });
    const capabilityBlocked = new Promise<void>((resolve) => {
      releaseCapabilityLookup = resolve;
    });
    const queryCodex = vi.fn(async () => {
      return {
        ok: false,
        text: '',
        error: 'Stop requested.',
        durationMs: 1,
        stopState: 'stop_requested' as const,
      };
    });
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      describeCapabilities: async (provider) => {
        capabilityLookupStarted();
        await capabilityBlocked;
        return capability(provider);
      },
      queryCodex,
    });

    const run = manager.startSession({
      sessionId: 'session_prestart_stop',
      provider: 'codex-sdk',
      authorityProfileId: 'codex-sdk:app-supervised',
      prompt: 'long turn',
      cwd: '/workspace',
      workspaceGrounding: 'not-required',
    });
    await capabilityStarted;

    expect(manager.requestStop('session_prestart_stop')).toEqual({
      ok: true,
      cancelled: true,
      state: 'stop_requested',
    });
    releaseCapabilityLookup();

    await expect(run).resolves.toMatchObject({
      ok: false,
      stopState: 'stop_requested',
      error: 'Stop requested.',
    });
    expect(queryCodex).not.toHaveBeenCalled();
    expect(manager.getSession('session_prestart_stop')).toMatchObject({
      status: 'stop_unconfirmed',
      terminalReason: 'Stop requested.',
    });
  });

  it('uses the main-owned session id when cancelling late renderer work', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    insertRunningTurn(db, 'renderer-turn-id', 'codex-sdk');
    const cancelRenderer = vi.fn(() => 0);
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      describeCapabilities: async (provider) => capability(provider),
      cancelRendererToolCallsForTurn: cancelRenderer,
      queryCodex: async () => ({
        ok: true,
        text: 'done',
        durationMs: 1,
        stopState: 'completed',
      }),
    });
    markTurnStartedAfterManagerRecovery(db, 'renderer-turn-id');

    await expect(
      manager.startSession({
        sessionId: 'main-session-id',
        conversationId: 'conversation_renderer-turn-id',
        turnId: 'renderer-turn-id',
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:app-supervised',
        prompt: 'finish normally',
        cwd: '/workspace',
        workspaceGrounding: 'not-required',
      })
    ).resolves.toMatchObject({ ok: true });

    cancelRenderer.mockReturnValue(1);
    expect(manager.requestStop('main-session-id')).toEqual({
      ok: true,
      cancelled: true,
      state: 'stop_requested',
    });
    expect(cancelRenderer).toHaveBeenLastCalledWith('main-session-id');
    expect(cancelRenderer).not.toHaveBeenCalledWith('renderer-turn-id');
  });

  it('marks stale running sessions interrupted on startup recovery', () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `
        INSERT INTO agent_sessions (
          id, provider, authority_profile_id, authority_class, release_mode,
          permission_mode_label, status, cwd, provider_versions_json, authority_json,
          started_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      'session_stale',
      'codex-sdk',
      'codex-sdk:app-supervised',
      'app-supervised',
      'read_only',
      'app-supervised',
      'running',
      '/workspace',
      '{}',
      '{}',
      1,
      1
    );

    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      now: () => 42,
    });

    expect(manager.getSession('session_stale')).toMatchObject({
      status: 'interrupted',
      terminalReason: 'App restarted before the provider session completed.',
      completedAt: 42,
    });
    const outbox = db
      .prepare(
        `SELECT event_name, reference_kind, reference_id, properties_json
           FROM analytics_event_outbox WHERE reference_id = ?`
      )
      .get('session_stale') as {
      event_name: string;
      reference_kind: string;
      reference_id: string;
      properties_json: string;
    };
    expect(outbox).toMatchObject({
      event_name: 'ai_turn_finished',
      reference_kind: 'ai_turn_terminal',
      reference_id: 'session_stale',
    });
    expect(JSON.parse(outbox.properties_json)).toMatchObject({
      route: 'local_codex',
      outcome: 'interrupted',
      reason_code: 'app_restarted',
      stage: 'recovery',
      workspace_tool_count_bucket: 'unknown',
      value_delivered: false,
    });
  });

  it('recovers stale Stop intent as interrupted/stop_unconfirmed exactly once', () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO agent_sessions (
        id, provider, authority_profile_id, authority_class, release_mode,
        permission_mode_label, status, cwd, provider_versions_json, authority_json,
        telemetry_had_workspace_context, telemetry_continuation, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'session_stop_stale',
      'claude-agent-sdk',
      'claude-agent-sdk:app-supervised',
      'app-supervised',
      'read_only',
      'app-supervised',
      'stopping',
      '/workspace',
      '{}',
      '{}',
      1,
      1,
      10,
      10
    );

    new AgentSessionManager({ db, releaseChannel: 'development', now: () => 42 });
    new AgentSessionManager({ db, releaseChannel: 'development', now: () => 100 });

    const rows = db
      .prepare(
        `SELECT properties_json FROM analytics_event_outbox
          WHERE reference_kind = 'ai_turn_terminal' AND reference_id = ?`
      )
      .all('session_stop_stale') as Array<{ properties_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.properties_json)).toMatchObject({
      route: 'local_claude',
      outcome: 'interrupted',
      initiated_by: 'user',
      reason_code: 'stop_unconfirmed',
      had_workspace_context: true,
      continuation: true,
    });
  });

  it('commits one content-free terminal event after a successful local turn', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      describeCapabilities: async (provider) => capability(provider),
      resolveScratchCwd: async (sessionId) => `/tmp/scratch/${sessionId}`,
      queryClaudeCode: async (_prompt, options) => {
        options.traceSink?.({
          transport: 'claude-agent-sdk',
          sequence: 1,
          receivedAt: '2026-09-02T00:00:00.000Z',
          providerEventType: 'assistant',
          raw: { private: 'must remain local' },
          display: publicAgentTraceDisplay({
            kind: 'assistant_text',
            title: 'Assistant',
            text: 'private answer',
          }),
          versions: { sdkVersion: '1', cliVersion: '1' },
        });
        return {
          ok: true,
          text: 'private answer',
          durationMs: 1_500,
          stopState: 'completed' as const,
        };
      },
    });

    await expect(
      manager.startSession({
        sessionId: 'session_terminal_success',
        provider: 'claude-agent-sdk',
        authorityProfileId: 'claude-agent-sdk:app-supervised',
        prompt: 'private prompt',
        cwd: null,
        workspaceGrounding: 'not-required',
      })
    ).resolves.toMatchObject({ ok: true, text: 'private answer' });

    const row = db
      .prepare(
        `SELECT event_id, properties_json FROM analytics_event_outbox
          WHERE reference_id = ?`
      )
      .get('session_terminal_success') as { event_id: string; properties_json: string };
    const properties = JSON.parse(row.properties_json) as Record<string, unknown>;
    expect(properties).toMatchObject({
      $insert_id: row.event_id,
      route: 'local_claude',
      outcome: 'completed',
      qualification_basis: 'completed_response',
      duration_bucket: '1_5s',
      had_workspace_context: false,
      continuation: false,
    });
    expect(row.properties_json).not.toContain('private answer');
    expect(row.properties_json).not.toContain('private prompt');
    expect(row.properties_json).not.toContain('/tmp/scratch');
  });

  it('does not claim acknowledged Stop from partial assistant trace items', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const actionId = '22222222-2222-4222-8222-222222222222';
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      resolveAutomaticSkillInstructions: async () => ({
        additionalInstructions: '',
        enabledNativeSkillIds: [],
        disabledNativeSkillIds: [],
        portableSkills: [],
      }),
      describeCapabilities: async (provider) => capability(provider),
      resolveScratchCwd: async (sessionId) => `/tmp/scratch/${sessionId}`,
      queryClaudeCode: async (_prompt, options) => {
        options.traceSink?.({
          transport: 'claude-agent-sdk',
          sequence: 1,
          receivedAt: '2026-10-13T00:00:00.000Z',
          providerEventType: 'assistant',
          providerItemId: 'text-1',
          raw: {},
          display: publicAgentTraceDisplay({
            kind: 'assistant_text',
            title: 'Assistant',
            text: 'Private partial answer',
          }),
          versions: { sdkVersion: '1', cliVersion: '1' },
        });
        options.traceSink?.({
          transport: 'claude-agent-sdk',
          sequence: 2,
          receivedAt: '2026-10-13T00:00:00.001Z',
          providerEventType: 'assistant',
          providerItemId: 'thought-1',
          raw: {},
          display: publicAgentTraceDisplay({
            kind: 'reasoning',
            title: 'Thinking',
            text: 'Private reasoning',
          }),
          versions: { sdkVersion: '1', cliVersion: '1' },
        });
        return {
          ok: false,
          text: '',
          error: 'Stop requested.',
          durationMs: 1500,
          stopState: 'stop_requested' as const,
        };
      },
    });
    insertRunningTurn(db, actionId, 'claude-agent-sdk');
    await manager.startSession({
      sessionId: 'session_partial_stop',
      conversationId: `conversation_${actionId}`,
      turnId: actionId,
      provider: 'claude-agent-sdk',
      authorityProfileId: 'claude-agent-sdk:app-supervised',
      prompt: 'Private prompt',
      cwd: null,
      workspaceGrounding: 'not-required',
    });
    const row = db
      .prepare('SELECT properties_json FROM analytics_event_outbox WHERE reference_id = ?')
      .get('session_partial_stop') as { properties_json: string };
    expect(JSON.parse(row.properties_json)).toMatchObject({
      action_id: actionId,
      outcome: 'interrupted',
      reason_code: 'stop_unconfirmed',
      value_delivered: false,
      qualification_basis: 'none',
      effect_state: 'none',
    });
    expect(row.properties_json).not.toMatch(/Private|scratch|text-1|thought-1/);
  });

  it('resolves a per-session scratch cwd when no workspace is mounted ', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const resolveScratchCwd = vi.fn(async (sessionId: string) => `/tmp/scratch/${sessionId}`);
    let observedCwd: string | undefined;
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      cliMcpBridgeProvider: bridge,
      describeCapabilities: async (provider) => capability(provider),
      resolveScratchCwd,
      queryCodex: async (_prompt, options) => {
        observedCwd = options.cwd ?? undefined;
        return { ok: true, text: 'done', durationMs: 5, stopState: 'completed' };
      },
    });

    const result = await manager.startSession({
      sessionId: 'session_scratch',
      conversationId: null,
      turnId: null,
      provider: 'codex-sdk',
      authorityProfileId: 'codex-sdk:app-supervised',
      prompt: 'chat with no workspace',
      cwd: null,
      workspaceGrounding: 'not-required',
    });

    expect(resolveScratchCwd).toHaveBeenCalledWith('session_scratch');
    expect(observedCwd).toBe('/tmp/scratch/session_scratch');
    expect(result.ok).toBe(true);
    expect(manager.getSession('session_scratch')).toMatchObject({
      cwd: '/tmp/scratch/session_scratch',
    });
  });

  it('logs the real cause but shows the cleaned failure on a failed CLI turn ', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const logFailure = vi.fn();
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      cliMcpBridgeProvider: bridge,
      describeCapabilities: async (provider) => capability(provider),
      logFailure,
      queryCodex: async (_prompt, options) => {
        options.traceSink?.(
          new CodexTraceAdapter({ sdkVersion: null, cliVersion: null }).adapt({
            type: 'turn.failed',
            error: { message: 'codex exited: spawn ENOENT for /usr/local/bin/codex' },
          })
        );
        return { ok: false, text: '', error: 'exit 1', durationMs: 7, stopState: 'failed' };
      },
    });

    const result = await manager.startSession({
      sessionId: 'session_fail',
      conversationId: null,
      turnId: null,
      provider: 'codex-sdk',
      authorityProfileId: 'codex-sdk:app-supervised',
      prompt: 'do a thing',
      cwd: '/workspace',
      workspaceGrounding: 'not-required',
      model: 'gpt-5-codex',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(userMessage('assistant.failed'));
    expect(logFailure).toHaveBeenCalledTimes(1);
    expect(logFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session_fail',
        provider: 'codex-sdk',
        authorityProfileId: 'codex-sdk:app-supervised',
        cwd: '/workspace',
        model: 'gpt-5-codex',
        error: 'exit 1',
        traceDetail: expect.stringContaining('spawn ENOENT'),
        stopState: 'failed',
      })
    );
  });

  it('does not log or enrich a normal stop ', async () => {
    const db = createTestDb();
    ensureSchema(db, ':memory:');
    const logFailure = vi.fn();
    const manager = new AgentSessionManager({
      db,
      releaseChannel: 'development',
      cliMcpBridgeProvider: bridge,
      describeCapabilities: async (provider) => capability(provider),
      logFailure,
      queryCodex: async () => ({
        ok: false,
        text: '',
        error: 'Generation stopped.',
        durationMs: 3,
        stopState: 'stop_requested',
      }),
    });

    const result = await manager.startSession({
      sessionId: 'session_stop',
      conversationId: null,
      turnId: null,
      provider: 'codex-sdk',
      authorityProfileId: 'codex-sdk:app-supervised',
      prompt: 'stop me',
      cwd: '/workspace',
      workspaceGrounding: 'not-required',
    });

    expect(result.error).toBe('Generation stopped.');
    expect(logFailure).not.toHaveBeenCalled();
  });
});
