import { afterEach, describe, expect, it, vi } from 'vitest';

const launchAppServer = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: {
    getPath: (name: string) => `/tmp/dnaforge-confirmed-stop-${process.pid}-${name}`,
    getVersion: () => '1.0.0',
    isPackaged: false,
  },
}));
vi.mock('../../analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../protein-experiment-workers', () => ({
  proteinExperimentRendererForTurn: vi.fn(),
}));
vi.mock('../../agent-sdk/agent-permission-catalog', async () => ({
  readAgentPermissionCatalog: async () =>
    (await import('../../../shared/agent-permissions')).BUILT_IN_AGENT_PERMISSION_CATALOG,
}));
vi.mock('../../agent-sdk/detect', () => ({
  detectAgentSdk: vi.fn(),
  detectClaudeCode: vi.fn(),
  detectGrok: vi.fn(),
  detectCodex: async () => ({
    path: '/fixture/codex',
    auth: 'authenticated',
    authMode: 'chatgpt',
  }),
  readCodexConfiguredReasoningEffort: async () => null,
  readCodexConfiguredMcpServerNames: async () => [],
}));
vi.mock('../../agent-sdk/agent-process-confinement', () => ({
  prepareManagedAgentProcessConfinement: async ({ cwd }: { cwd: string }) => ({
    cwd,
    scratchRoot: '/fixture/scratch',
    wrap: () => {
      throw new Error('The transport fixture must not launch a process.');
    },
    dispose: vi.fn(),
  }),
}));
vi.mock('../../agent-sdk/local-codex-app-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-sdk/local-codex-app-server')>()),
  launchLocalCodexAppServer: launchAppServer,
}));

import { createFileTestDb, openFileTestDb } from '../../__tests__/test-db';
import { ensureSchema } from '../../schema';
import { AgentSessionManager, type AgentSessionManagerDependencies } from '../manager';
import type { ProviderCapabilityReport } from '../types';
import { STOPPED_ASSISTANT_NOTICE } from '../../../shared/hosted-codex-stopped-answer';

const capabilities: ProviderCapabilityReport = {
  provider: 'codex-sdk',
  auth: 'authenticated',
  versions: { sdkVersion: '0.133.0', cliVersion: 'codex 0.136.0', binaryPath: '/fixture/codex' },
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const fixtures: ReturnType<typeof createFileTestDb>[] = [];

function database() {
  const fixture = createFileTestDb('confirmed-stop-receipt');
  ensureSchema(fixture.db, fixture.dbPath);
  fixtures.push(fixture);
  return fixture;
}

function manager(
  db: ReturnType<typeof openFileTestDb>,
  overrides: Partial<AgentSessionManagerDependencies> = {}
) {
  return new AgentSessionManager({
    db,
    releaseChannel: 'development',
    now: () => 100,
    describeCapabilities: async () => capabilities,
    resolveAutomaticSkillInstructions: async () => ({
      additionalInstructions: null,
      enabledNativeSkillIds: [],
      disabledNativeSkillIds: [],
      portableSkills: [],
    }),
    requestUserInputProvider: () => async () => ({ outcome: 'cancelled', answers: {} }),
    cancelRendererToolCallsForTurn: () => 0,
    ...overrides,
  });
}

function request(sessionId: string) {
  return {
    sessionId,
    provider: 'codex-sdk' as const,
    authorityProfileId: 'codex-sdk:app-supervised',
    prompt: 'Inspect the synthetic sequence.',
    cwd: '/workspace',
    workspaceGrounding: 'not-required' as const,
    toolExposure: 'none' as const,
  };
}

function receipts(db: ReturnType<typeof openFileTestDb>, sessionId: string) {
  const rows = db
    .prepare(
      `SELECT event_name, reference_kind, properties_json FROM analytics_event_outbox
       WHERE reference_id = ?`
    )
    .all(sessionId) as Array<{
    event_name: string;
    reference_kind: string;
    properties_json: string;
  }>;
  for (const row of rows) {
    expect(row.event_name).toBe('ai_turn_finished');
    expect(row.reference_kind).toBe('ai_turn_terminal');
  }
  return rows.map((row) => JSON.parse(row.properties_json));
}

function sdkTransport() {
  const started = deferred<void>();
  let notification: ((value: { method: string; params: unknown }) => void) | null = null;
  let exited: (() => void) | null = null;
  const interrupt = vi.fn();
  const dispose = vi.fn();
  const emit = (method: string, params: unknown) => notification?.({ method, params });
  launchAppServer.mockResolvedValueOnce({
    protocol: { client: ['model/list'] },
    supervisor: {
      request: vi.fn(async (method: string) => {
        if (method === 'model/list') {
          return {
            data: [
              {
                id: 'fixture-model',
                displayName: 'Fixture model',
                isDefault: true,
                supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
              },
            ],
            nextCursor: null,
          };
        }
        if (method === 'thread/start') return { thread: { id: 'thread-stop-receipt' } };
        if (method === 'turn/start') {
          queueMicrotask(() => {
            emit('turn/started', {
              threadId: 'thread-stop-receipt',
              turn: { id: 'turn-stop-receipt' },
            });
            started.resolve();
          });
          return { turn: { id: 'turn-stop-receipt' } };
        }
        throw new Error(`Unexpected provider request: ${method}`);
      }),
      setNotificationListener(listener: typeof notification) {
        notification = listener;
      },
      setServerRequestHandler: vi.fn(),
      onExit(listener: () => void) {
        exited = listener;
      },
      interrupt,
    },
    dispose,
  });
  return {
    started: started.promise,
    interrupt,
    dispose,
    append(text: string) {
      emit('item/agentMessage/delta', {
        threadId: 'thread-stop-receipt',
        turnId: 'turn-stop-receipt',
        itemId: 'message-stop-receipt',
        delta: text,
      });
    },
    acknowledgeInterruption() {
      emit('turn/completed', {
        threadId: 'thread-stop-receipt',
        turn: { id: 'turn-stop-receipt', status: 'interrupted', error: null, items: [] },
      });
    },
    exitWithoutAcknowledgement() {
      exited?.();
    },
  };
}

afterEach(() => {
  launchAppServer.mockReset();
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

describe('confirmed user Stop terminal receipts', () => {
  it.each([
    {
      label: 'useful partial response',
      text: 'The synthetic sequence has two exons.',
      value: true,
    },
    { label: 'stopped marker only', text: STOPPED_ASSISTANT_NOTICE, value: false },
    { label: 'paused marker only', text: '*[Paused]*', value: false },
  ])('qualifies $label only after the real typed SDK acknowledgement', async ({ text, value }) => {
    const fixture = database();
    const transport = sdkTransport();
    const owner = manager(fixture.db);
    const run = owner.startSession(request('acknowledged_stop'));
    await transport.started;
    transport.append(text);

    expect(owner.requestStop('acknowledged_stop')).toMatchObject({
      ok: true,
      state: 'stop_requested',
    });
    expect(transport.interrupt).toHaveBeenCalledOnce();
    expect(owner.getSession('acknowledged_stop')).toMatchObject({
      status: 'stopping',
      completedAt: null,
    });
    expect(receipts(fixture.db, 'acknowledged_stop')).toEqual([]);

    transport.acknowledgeInterruption();
    expect(await run).toMatchObject({ stopState: 'cancelled', text });
    expect(transport.dispose).toHaveBeenCalledOnce();
    expect(owner.getSession('acknowledged_stop')).toMatchObject({
      status: 'cancelled',
      providerConversationId: 'thread-stop-receipt',
      completedAt: 100,
    });
    const events = receipts(fixture.db, 'acknowledged_stop');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      route: 'local_codex',
      outcome: 'stopped',
      initiated_by: 'user',
      reason_code: 'user_stop_acknowledged',
      value_delivered: value,
      qualification_basis: value ? 'partial_response_before_stop' : 'none',
    });
    expect(JSON.stringify(events)).not.toContain(text);
    owner.requestStop('acknowledged_stop');
    expect(receipts(fixture.db, 'acknowledged_stop')).toEqual(events);
  });

  it('keeps a provider interruption without a user Stop as provider cancellation', async () => {
    const fixture = database();
    const transport = sdkTransport();
    const owner = manager(fixture.db);
    const run = owner.startSession(request('provider_interruption'));
    await transport.started;
    transport.append('The synthetic sequence has two exons.');
    transport.acknowledgeInterruption();
    expect(await run).toMatchObject({ stopState: 'cancelled' });
    expect(transport.interrupt).not.toHaveBeenCalled();
    const events = receipts(fixture.db, 'provider_interruption');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'cancelled',
      initiated_by: 'provider',
      reason_code: 'provider_cancelled',
      value_delivered: false,
      qualification_basis: 'none',
    });
  });

  it('does not turn Stop intent followed by an unacknowledged exit into delivered value', async () => {
    const fixture = database();
    const transport = sdkTransport();
    const owner = manager(fixture.db);
    const run = owner.startSession(request('unacknowledged_stop'));
    await transport.started;
    transport.append('The synthetic sequence has two exons.');
    owner.requestStop('unacknowledged_stop');
    expect(receipts(fixture.db, 'unacknowledged_stop')).toEqual([]);
    transport.exitWithoutAcknowledgement();
    expect(await run).toMatchObject({ stopState: 'stop_requested' });
    expect(owner.getSession('unacknowledged_stop')).toMatchObject({ status: 'stop_unconfirmed' });
    const events = receipts(fixture.db, 'unacknowledged_stop');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'interrupted',
      initiated_by: 'user',
      reason_code: 'stop_unconfirmed',
      value_delivered: false,
      qualification_basis: 'none',
    });
  });

  it('does not infer a user acknowledgement from a bare cancelled result after Stop', async () => {
    const fixture = database();
    const entered = deferred<void>();
    const provider = deferred<{
      ok: boolean;
      text: string;
      durationMs: number;
      stopState: 'cancelled';
    }>();
    const owner = manager(fixture.db, {
      queryCodex: async () => {
        entered.resolve();
        return provider.promise;
      },
    });
    const run = owner.startSession(request('bare_cancelled'));
    await entered.promise;
    owner.requestStop('bare_cancelled');
    provider.resolve({
      ok: false,
      text: 'The synthetic sequence has two exons.',
      durationMs: 2,
      stopState: 'cancelled',
    });
    expect(await run).toMatchObject({ stopState: 'cancelled' });
    const events = receipts(fixture.db, 'bare_cancelled');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'cancelled',
      initiated_by: 'provider',
      reason_code: 'provider_cancelled',
      value_delivered: false,
      qualification_basis: 'none',
    });
  });

  it('recovers a persisted stopping session without inventing provider acknowledgement', () => {
    const fixture = database();
    fixture.db
      .prepare(
        `INSERT INTO agent_sessions (
          id, provider, authority_profile_id, authority_class, release_mode, status, cwd,
          provider_conversation_id, provider_versions_json, authority_json,
          started_at, updated_at, completed_at
        ) VALUES ('recovered_stop', 'codex-sdk', 'codex-sdk:app-supervised',
          'app-supervised', 'read_only', 'stopping', '/workspace', 'thread-stop-receipt',
          '{}', '{}', 10, 20, NULL)`
      )
      .run();
    fixture.db.close();
    fixture.db = openFileTestDb(fixture.dbPath);
    const owner = manager(fixture.db);
    expect(owner.getSession('recovered_stop')).toMatchObject({
      status: 'stop_unconfirmed',
      completedAt: 100,
    });
    expect(owner.recoverInterruptedSessions()).toBe(0);
    const events = receipts(fixture.db, 'recovered_stop');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'interrupted',
      initiated_by: 'user',
      stage: 'recovery',
      reason_code: 'stop_unconfirmed',
      value_delivered: false,
      qualification_basis: 'none',
    });
    expect(launchAppServer).not.toHaveBeenCalled();
  });
});
