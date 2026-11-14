import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: {
    getPath: vi.fn((name: string) => `/tmp/dnaforge-agent-session-${process.pid}-${name}`),
    getVersion: vi.fn(() => '1.0.0'),
    isPackaged: false,
  },
}));
vi.mock('../../analytics', () => ({ trackEvent: vi.fn() }));

import { createFileTestDb, openFileTestDb } from '../../__tests__/test-db';
import type { QueryOptions } from '../../agent-sdk/query';
import { ensureSchema } from '../../schema';
import { AgentSessionManager } from '../manager';
import type { AgentProvider, ProviderCapabilityReport } from '../types';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function capability(provider: AgentProvider): ProviderCapabilityReport {
  return {
    provider,
    auth: 'authenticated',
    versions: { sdkVersion: 'test-sdk', cliVersion: 'test-cli', binaryPath: '/test/cli' },
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

function emptyAutomaticSkillLookup() {
  return vi.fn(async () => ({
    additionalInstructions: null,
    enabledNativeSkillIds: [],
    disabledNativeSkillIds: [],
    portableSkills: [],
  }));
}

describe('AgentSessionManager provider continuation', () => {
  it.each([
    {
      provider: 'codex-sdk' as const,
      authorityProfileId: 'codex-sdk:app-supervised',
      hostId: 'codex-cli',
      providerThreadId: 'codex-thread-after-restart',
      previousTurnStatus: 'stopped',
      previousSessionStatus: 'stop_requested',
    },
    {
      provider: 'claude-agent-sdk' as const,
      authorityProfileId: 'claude-agent-sdk:app-supervised',
      hostId: 'claude-cli',
      providerThreadId: 'claude-session-after-restart',
      previousTurnStatus: 'stopped',
      previousSessionStatus: 'stop_requested',
    },
  ])(
    'reopens SQLite and resumes the durable $provider thread using only the current delta',
    async ({
      provider,
      authorityProfileId,
      hostId,
      providerThreadId,
      previousTurnStatus,
      previousSessionStatus,
    }) => {
      const fixture = createFileTestDb(`provider-continuation-${provider}`);
      cleanups.push(fixture.cleanup);
      ensureSchema(fixture.db, fixture.dbPath);
      fixture.db
        .prepare(
          `INSERT INTO conversations (id, title, created_at, updated_at, provider, model)
           VALUES ('conv-resume', 'Resume test', 1, 1, ?, ?)`
        )
        .run(provider, provider);
      fixture.db
        .prepare(
          `INSERT INTO chat_turns (
            id, conversation_id, route_kind, host_id, transport, authority_profile_id,
            permission_mode, route_snapshot_json, status, started_at, completed_at
          ) VALUES ('turn-previous', 'conv-resume', 'cli', ?, ?, ?,
            'app-supervised', '{}', ?, 1, 2)`
        )
        .run(hostId, provider, authorityProfileId, previousTurnStatus);
      fixture.db
        .prepare(
          `INSERT INTO agent_sessions (
            id, conversation_id, turn_id, provider, authority_profile_id, authority_class,
            release_mode, status, cwd, provider_conversation_id, provider_versions_json,
            authority_json, started_at, updated_at, completed_at
          ) VALUES ('session-previous', 'conv-resume', 'turn-previous', ?, ?,
            'app-supervised', 'read_only', ?, '/workspace', ?, '{}', '{}', 1, 2, 2)`
        )
        .run(provider, authorityProfileId, previousSessionStatus, providerThreadId);
      fixture.db.pragma('user_version = 47');
      fixture.db.close();

      const reopened = openFileTestDb(fixture.dbPath);
      ensureSchema(reopened, fixture.dbPath);
      const queryProvider = vi.fn(async (prompt: string, options: QueryOptions) => {
        expect(prompt).toBe('CURRENT_DELTA_ONLY');
        expect(options.providerConversationId).toBe(providerThreadId);
        expect(options.turnId).toBe('session-current');
        return {
          ok: true,
          text: 'continued',
          durationMs: 1,
          stopState: 'completed' as const,
          providerConversationId: providerThreadId,
        };
      });
      const resolveAutomaticSkillInstructions = emptyAutomaticSkillLookup();
      const manager = new AgentSessionManager({
        resolveAutomaticSkillInstructions,
        db: reopened,
        releaseChannel: 'development',
        describeCapabilities: async (candidate) => capability(candidate),
        queryCodex: queryProvider,
        queryClaudeCode: queryProvider,
      });

      reopened
        .prepare(
          `INSERT INTO chat_turns (
            id, conversation_id, route_kind, host_id, transport, authority_profile_id,
            permission_mode, route_snapshot_json, status, started_at
          ) VALUES ('turn-current', 'conv-resume', 'cli', ?, ?, ?,
            'app-supervised', '{}', 'running', 3)`
        )
        .run(hostId, provider, authorityProfileId);

      await expect(
        manager.startSession({
          sessionId: 'session-current',
          conversationId: 'conv-resume',
          turnId: 'turn-current',
          provider,
          authorityProfileId,
          prompt: 'FULL_TRANSCRIPT_SEED_MUST_NOT_BE_SENT',
          continuationPrompt: 'CURRENT_DELTA_ONLY',
          cwd: '/workspace',
          workspaceGrounding: 'not-required',
        })
      ).resolves.toMatchObject({
        ok: true,
        providerConversationId: providerThreadId,
      });

      expect(resolveAutomaticSkillInstructions).toHaveBeenCalledTimes(1);
      expect(resolveAutomaticSkillInstructions).toHaveBeenCalledWith({
        provider,
        workspacePath: '/workspace',
      });
      expect(queryProvider).toHaveBeenCalledTimes(1);
      expect(manager.getSession('session-current')).toMatchObject({
        conversationId: 'conv-resume',
        turnId: 'turn-current',
        provider,
        providerConversationId: providerThreadId,
        status: 'completed',
      });
      reopened.close();
    }
  );

  it('revalidates selected app memory in main and injects it as lower-priority context', async () => {
    const fixture = createFileTestDb('selected-capability-main-boundary');
    cleanups.push(fixture.cleanup);
    ensureSchema(fixture.db, fixture.dbPath);
    fixture.db
      .prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at, provider, model)
         VALUES ('conv-memory', 'Memory test', 1, 1, 'codex-sdk', 'codex-sdk')`
      )
      .run();
    const resolveCapabilityInstructions = vi.fn(async () => ({
      additionalInstructions: 'Selected memory: use E. coli K-12.',
      control: {
        id: 'codex-sdk:memory:memory-1',
        provider: 'codex-sdk' as const,
        nativeId: 'memory-1',
        kind: 'memory' as const,
        label: 'Organism',
        description: 'Selected test memory.',
        scope: 'workspace' as const,
        effects: ['instructions' as const],
        availability: { state: 'supported' as const },
        stages: {
          advertised: true,
          discoverable: true,
          invocable: true,
          visible: true,
          deterministic: true,
          liveQualified: false,
        },
        source: 'dnaforge-memory:memory-1',
      },
    }));
    const queryCodex = vi.fn(async (_prompt: string, options: QueryOptions) => {
      expect(options.additionalAgentInstructions).toBe('User preference.');
      expect(options.runtimeAgentInstructions).toBe('Selected memory: use E. coli K-12.');
      return {
        ok: true,
        text: 'used selected memory',
        durationMs: 1,
        stopState: 'completed' as const,
      };
    });
    const resolveAutomaticSkillInstructions = emptyAutomaticSkillLookup();
    const manager = new AgentSessionManager({
      resolveAutomaticSkillInstructions,
      db: fixture.db,
      releaseChannel: 'development',
      describeCapabilities: async (provider) => capability(provider),
      resolveCapabilityInstructions,
      queryCodex,
    });
    fixture.db
      .prepare(
        `INSERT INTO chat_turns (
           id, conversation_id, route_kind, host_id, transport, authority_profile_id,
           permission_mode, route_snapshot_json, status, started_at
         ) VALUES ('turn-memory', 'conv-memory', 'cli', 'codex-cli', 'codex-sdk',
           'codex-sdk:app-supervised', 'app-supervised', '{}', 'running', 2)`
      )
      .run();
    const selection = {
      snapshotId: 'snapshot-1',
      provider: 'codex-sdk' as const,
      capabilityId: 'codex-sdk:memory:memory-1',
    };

    await manager.startSession({
      sessionId: 'session-memory',
      conversationId: 'conv-memory',
      turnId: 'turn-memory',
      provider: 'codex-sdk',
      authorityProfileId: 'codex-sdk:app-supervised',
      prompt: 'Use the selected context.',
      cwd: '/workspace',
      workspaceGrounding: 'not-required',
      additionalAgentInstructions: 'User preference.',
      capabilitySelection: selection,
    });

    expect(resolveCapabilityInstructions).toHaveBeenCalledWith({
      selection,
      provider: 'codex-sdk',
      workspacePath: '/workspace',
      conversationId: 'conv-memory',
    });
    expect(resolveAutomaticSkillInstructions).toHaveBeenCalledTimes(1);
    expect(resolveAutomaticSkillInstructions).toHaveBeenCalledWith({
      provider: 'codex-sdk',
      workspacePath: '/workspace',
    });
    expect(queryCodex).toHaveBeenCalledOnce();
    expect(
      fixture.db
        .prepare(
          `SELECT capability_id, kind, label, source
           FROM agent_capability_invocations
           WHERE turn_id = 'turn-memory'`
        )
        .get()
    ).toEqual({
      capability_id: 'codex-sdk:memory:memory-1',
      kind: 'memory',
      label: 'Organism',
      source: 'dnaforge-memory:memory-1',
    });
  });
});
