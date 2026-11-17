import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: {
    getPath: (name: string) => `/tmp/dnaforge-stop-state-${process.pid}-${name}`,
    getVersion: () => '1.0.0',
    isPackaged: false,
  },
}));
vi.mock('../../analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../../agent-sdk/agent-permission-catalog', async () => ({
  readAgentPermissionCatalog: async () =>
    (await import('../../../shared/agent-permissions')).BUILT_IN_AGENT_PERMISSION_CATALOG,
}));

import { createFileTestDb, openFileTestDb } from '../../__tests__/test-db';
import { ensureSchema } from '../../schema';
import { AgentSessionManager, type AgentSessionManagerDependencies } from '../manager';
import { findProviderContinuation } from '../provider-continuation';
import type { ProviderCapabilityReport } from '../types';
import type { QueryOptions } from '../../agent-sdk/query';

type ProviderQueryResult = Awaited<
  ReturnType<NonNullable<AgentSessionManagerDependencies['queryCodex']>>
>;

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

const fixtures: Array<
  ReturnType<typeof createFileTestDb> & { name: string; observations: unknown[] }
> = [];

function database(name: string) {
  const fixture = {
    ...createFileTestDb(`agent-stop-${name}`),
    name,
    observations: [] as unknown[],
  };
  ensureSchema(fixture.db, fixture.dbPath);
  fixtures.push(fixture);
  return fixture;
}

function outbox(db: ReturnType<typeof openFileTestDb>, sessionId: string) {
  return (
    db
      .prepare('SELECT properties_json FROM analytics_event_outbox WHERE reference_id = ?')
      .all(sessionId) as Array<{ properties_json: string }>
  ).map((row) => JSON.parse(row.properties_json));
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
    cancelRendererToolCallsForTurn: () => 0,
    ...overrides,
  });
}

function request(sessionId: string) {
  return {
    sessionId,
    provider: 'codex-sdk' as const,
    authorityProfileId: 'codex-sdk:app-supervised',
    prompt: 'Synthetic lifecycle acceptance',
    cwd: '/workspace',
    workspaceGrounding: 'not-required' as const,
    toolExposure: 'none' as const,
  };
}

function seedSession(
  db: ReturnType<typeof openFileTestDb>,
  id: string,
  status: string,
  completedAt: number | null
) {
  db.prepare(
    `INSERT INTO agent_sessions (
    id, provider, authority_profile_id, authority_class, release_mode, status, cwd,
    provider_conversation_id, provider_versions_json, authority_json, terminal_reason,
    started_at, updated_at, completed_at
  ) VALUES (?, 'codex-sdk', 'codex-sdk:app-supervised', 'app-supervised', 'read_only', ?, '/workspace',
    'thread-fixture', '{}', '{}', 'Preserved reason.', 10, 20, ?)`
  ).run(id, status, completedAt);
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    try {
      if (process.env.AGENT_STOP_EVIDENCE) {
        mkdirSync(process.env.AGENT_STOP_EVIDENCE, { recursive: true });
        await fixture.db.backup(
          path.join(process.env.AGENT_STOP_EVIDENCE, `${fixture.name}.sqlite`)
        );
        writeFileSync(
          path.join(process.env.AGENT_STOP_EVIDENCE, `${fixture.name}.json`),
          JSON.stringify(
            {
              observations: fixture.observations,
              sessions: fixture.db.prepare('SELECT * FROM agent_sessions ORDER BY id').all(),
              outbox: fixture.db
                .prepare('SELECT * FROM analytics_event_outbox ORDER BY reference_id')
                .all(),
            },
            null,
            2
          )
        );
      }
    } finally {
      if (fixture.db.open) fixture.db.close();
      fixture.cleanup();
    }
  }
});

describe('agent session stop-state acceptance', () => {
  it('keeps stopping active until observation ends without provider confirmation', async () => {
    const fixture = database('active-to-unconfirmed');
    const entered = deferred<QueryOptions>();
    const provider = deferred<ProviderQueryResult>();
    const owner = manager(fixture.db, {
      queryCodex: async (_prompt, options) => {
        entered.resolve(options);
        return provider.promise;
      },
    });
    const run = owner.startSession(request('stop_active'));
    const options = await entered.promise;
    const cancel = owner.requestStop('stop_active');
    const repeated = owner.requestStop('stop_active');
    const active = owner.getSession('stop_active');
    const activeEvents = outbox(fixture.db, 'stop_active');
    provider.resolve({
      ok: false,
      text: '',
      error: 'Stop requested.',
      durationMs: 3,
      stopState: 'stop_requested',
      providerConversationId: 'thread-fixture',
    });
    const result = await run;
    fixture.observations.push({ cancel, repeated, active, activeEvents, result });
    expect(cancel).toEqual({ ok: true, cancelled: true, state: 'stop_requested' });
    expect(repeated).toEqual(cancel);
    expect(options.abortController?.signal.aborted).toBe(true);
    expect(active).toMatchObject({ status: 'stopping', completedAt: null });
    expect(activeEvents).toEqual([]);
    expect(result.stopState).toBe('stop_requested');
    expect(owner.getSession('stop_active')).toMatchObject({
      status: 'stop_unconfirmed',
      completedAt: 100,
    });
    expect(outbox(fixture.db, 'stop_active')).toHaveLength(1);
    expect(outbox(fixture.db, 'stop_active')[0]).toMatchObject({
      reason_code: 'stop_unconfirmed',
      stage: 'provider_stream',
    });
    fixture.db.close();
    fixture.db = openFileTestDb(fixture.dbPath);
    expect(manager(fixture.db).getSession('stop_active')).toMatchObject({
      status: 'stop_unconfirmed',
      completedAt: 100,
    });
    expect(outbox(fixture.db, 'stop_active')).toHaveLength(1);
  });

  it('preserves provider-confirmed cancellation as a distinct terminal outcome', async () => {
    const fixture = database('confirmed-stop');
    const entered = deferred<void>();
    const provider = deferred<ProviderQueryResult>();
    const owner = manager(fixture.db, {
      queryCodex: async () => {
        entered.resolve();
        return provider.promise;
      },
    });
    const run = owner.startSession(request('stop_confirmed'));
    await entered.promise;
    owner.requestStop('stop_confirmed');
    provider.resolve({ ok: false, text: '', durationMs: 2, stopState: 'cancelled' });
    expect((await run).stopState).toBe('cancelled');
    expect(owner.getSession('stop_confirmed')).toMatchObject({
      status: 'cancelled',
      completedAt: 100,
    });
    expect(outbox(fixture.db, 'stop_confirmed')).toHaveLength(1);
    expect(outbox(fixture.db, 'stop_confirmed')[0]).toMatchObject({
      outcome: 'cancelled',
      reason_code: 'provider_cancelled',
    });
  });

  it('does not rewrite a committed outcome when late renderer work receives Stop', async () => {
    const fixture = database('late-renderer-stop');
    const cancelRenderer = vi.fn(() => 1);
    const owner = manager(fixture.db, {
      cancelRendererToolCallsForTurn: cancelRenderer,
      queryCodex: async () => ({
        ok: true,
        text: 'Completed answer.',
        durationMs: 2,
        stopState: 'completed',
      }),
    });
    await owner.startSession(request('already_completed'));
    const committed = owner.getSession('already_completed');
    const events = outbox(fixture.db, 'already_completed');
    const cancellation = owner.requestStop('already_completed');
    fixture.observations.push({
      committed,
      cancellation,
      afterStop: owner.getSession('already_completed'),
    });
    expect(cancellation.state).toBe('stop_requested');
    expect(cancelRenderer).toHaveBeenCalledWith('already_completed');
    expect(owner.getSession('already_completed')).toEqual(committed);
    expect(outbox(fixture.db, 'already_completed')).toEqual(events);
  });

  it('settles a stop requested before provider admission without launching the provider', async () => {
    const fixture = database('prestart-stop');
    const entered = deferred<void>();
    const admit = deferred<ProviderCapabilityReport>();
    const query = vi.fn();
    const owner = manager(fixture.db, {
      describeCapabilities: async () => {
        entered.resolve();
        return admit.promise;
      },
      queryCodex: query,
    });
    const run = owner.startSession(request('stop_prestart'));
    await entered.promise;
    owner.requestStop('stop_prestart');
    admit.resolve(capabilities);
    expect((await run).stopState).toBe('stop_requested');
    expect(query).not.toHaveBeenCalled();
    expect(owner.getSession('stop_prestart')).toMatchObject({
      status: 'stop_unconfirmed',
      completedAt: 100,
    });
    expect(outbox(fixture.db, 'stop_prestart')).toHaveLength(1);
  });

  it('migrates legacy stop records once without changing timestamps or content', () => {
    const fixture = database('legacy-migration');
    seedSession(fixture.db, 'legacy_active', 'stop_requested', null);
    seedSession(fixture.db, 'legacy_final', 'stop_requested', 30);
    const oldRows = fixture.db.prepare('SELECT * FROM agent_sessions ORDER BY id').all() as Array<
      Record<string, unknown>
    >;
    ensureSchema(fixture.db, fixture.dbPath);
    const migrated = fixture.db.prepare('SELECT * FROM agent_sessions ORDER BY id').all();
    fixture.db.close();
    fixture.db = openFileTestDb(fixture.dbPath);
    ensureSchema(fixture.db, fixture.dbPath);
    fixture.observations.push({ oldRows, migrated });
    expect(migrated).toEqual(
      oldRows.map((row) => ({
        ...row,
        status: row.completed_at === null ? 'stopping' : 'stop_unconfirmed',
      }))
    );
    expect(fixture.db.prepare('SELECT * FROM agent_sessions ORDER BY id').all()).toEqual(migrated);
    expect(outbox(fixture.db, 'legacy_final')).toEqual([]);
  });

  it('recovers active stopping once as terminal unconfirmed after reopening the database', () => {
    const fixture = database('recovered-stop');
    seedSession(fixture.db, 'stale_stopping', 'stopping', null);
    fixture.db.close();
    fixture.db = openFileTestDb(fixture.dbPath);
    ensureSchema(fixture.db, fixture.dbPath);
    const owner = manager(fixture.db);
    const recovered = owner.getSession('stale_stopping');
    expect(owner.recoverInterruptedSessions()).toBe(0);
    fixture.db.close();
    fixture.db = openFileTestDb(fixture.dbPath);
    const reopened = manager(fixture.db).getSession('stale_stopping');
    fixture.observations.push({ recovered, reopened });
    expect(recovered).toMatchObject({ status: 'stop_unconfirmed', completedAt: 100 });
    expect(reopened).toEqual(recovered);
    expect(outbox(fixture.db, 'stale_stopping')).toHaveLength(1);
    expect(outbox(fixture.db, 'stale_stopping')[0]).toMatchObject({
      reason_code: 'stop_unconfirmed',
      stage: 'recovery',
    });
  });

  it('allows continuation only after the previous session commits its terminal outcome', async () => {
    const fixture = database('continuation');
    const entered = deferred<void>();
    const provider = deferred<ProviderQueryResult>();
    const owner = manager(fixture.db, {
      queryCodex: async () => {
        entered.resolve();
        return provider.promise;
      },
    });
    fixture.db
      .prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at, provider, model)
      VALUES ('conversation', 'Synthetic continuation', 1, 1, 'codex-sdk', 'codex-sdk')`
      )
      .run();
    const addTurn = fixture.db
      .prepare(`INSERT INTO chat_turns (id, conversation_id, route_kind, host_id, transport,
      route_snapshot_json, status, started_at) VALUES (?, 'conversation', 'cli', 'codex-cli', 'codex-sdk', '{}', ?, 1)`);
    addTurn.run('previous', 'running');
    const run = owner.startSession({
      ...request('previous_session'),
      conversationId: 'conversation',
      turnId: 'previous',
    });
    await entered.promise;
    owner.requestStop('previous_session');
    fixture.db
      .prepare("UPDATE chat_turns SET status = 'stopped', completed_at = 50 WHERE id = 'previous'")
      .run();
    fixture.db
      .prepare(
        "UPDATE agent_sessions SET provider_conversation_id = 'thread-fixture' WHERE id = 'previous_session'"
      )
      .run();
    addTurn.run('current', 'running');
    const lookup = () =>
      findProviderContinuation(fixture.db, {
        conversationId: 'conversation',
        turnId: 'current',
        provider: 'codex-sdk',
      });
    const whileStopping = lookup();
    provider.resolve({
      ok: false,
      text: '',
      durationMs: 2,
      stopState: 'stop_requested',
      providerConversationId: 'thread-fixture',
    });
    await run;
    const afterSettlement = lookup();
    fixture.observations.push({ whileStopping, afterSettlement });
    expect(whileStopping).toBeNull();
    expect(afterSettlement).toBe('thread-fixture');
    expect(outbox(fixture.db, 'previous_session')).toHaveLength(1);
  });

  it('rejects continuation from a row that claims completion without a terminal commit', () => {
    const fixture = database('uncommitted-continuation');
    fixture.db
      .prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at, provider, model)
      VALUES ('conversation', 'Synthetic continuation', 1, 1, 'codex-sdk', 'codex-sdk')`
      )
      .run();
    fixture.db
      .prepare(
        `INSERT INTO chat_turns (id, conversation_id, route_kind, host_id, transport, route_snapshot_json, status, started_at)
      VALUES ('previous', 'conversation', 'cli', 'codex-cli', 'codex-sdk', '{}', 'stopped', 1),
        ('current', 'conversation', 'cli', 'codex-cli', 'codex-sdk', '{}', 'running', 2)`
      )
      .run();
    seedSession(fixture.db, 'uncommitted', 'completed', null);
    fixture.db
      .prepare(
        "UPDATE agent_sessions SET turn_id = 'previous', conversation_id = 'conversation' WHERE id = 'uncommitted'"
      )
      .run();
    expect(
      findProviderContinuation(fixture.db, {
        conversationId: 'conversation',
        turnId: 'current',
        provider: 'codex-sdk',
      })
    ).toBeNull();
  });
});
