import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

import type Database from 'better-sqlite3';

import { COMPUTE_CREDENTIAL_HEADER } from '../../shared/compute-ipc';
import { ensureSchema } from '../schema';
import { createTestDb } from '../__tests__/test-db';
import {
  ComputeJobRegistry,
  relocateImportedResult,
  POLL_BASE_MS,
  POLL_SLOW_AFTER_MS,
  POLL_SLOW_MS,
  settingsHash,
} from './jobs';

const SECRET = 'tmr-poller-SECRETVALUE';

let db: Database.Database;
let cleanup: () => void;
let clock: number;
let scheduled: Array<{ fn: () => void; at: number; canceled: boolean }>;
let statusScript: Array<{ status: number; body: unknown }>;
let seen: Array<{ url: string; credential: string | null; body: unknown }>;

function makeRegistry(
  overrides: Partial<ConstructorParameters<typeof ComputeJobRegistry>[0]> = {}
) {
  return new ComputeJobRegistry({
    db: () => db,
    sidecarFetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(url),
        credential: headers.get(COMPUTE_CREDENTIAL_HEADER),
        body: JSON.parse(String(init?.body)),
      });
      const next = statusScript.shift() ?? {
        status: 200,
        body: {
          state: 'running',
          provider_state: 'Running',
          cost_amount: null,
          cost_unit: null,
          terminal: false,
        },
      };
      return new Response(JSON.stringify(next.body), { status: next.status });
    },
    readCredential: async () => SECRET,
    grantedCapabilities: () => ['external-compute:discover'],
    now: () => clock,
    schedule: (fn, ms) => {
      const entry = { fn, at: clock + ms, canceled: false };
      scheduled.push(entry);
      return { cancel: () => void (entry.canceled = true) };
    },
    random: () => 0,
    ...overrides,
  });
}

async function fire(): Promise<void> {
  const due = scheduled.filter((s) => !s.canceled && s.at <= clock);
  scheduled = scheduled.filter((s) => !due.includes(s));
  for (const s of due) {
    s.fn();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  db = createTestDb();
  cleanup = () => db.close();
  ensureSchema(db, ':memory:');
  clock = 1_700_000_000_000;
  scheduled = [];
  statusScript = [];
  seen = [];
});

afterEach(() => {
  cleanup();
});

const intent = {
  provider: 'tamarind',
  toolId: 'alphafold',
  label: 'job-1',
  settings: { sequence: 'MKT', numModels: 1 },
  costEstimate: 0.4,
  costEstimateUnit: 'weighted_hours',
  workspaceRoot: '/ws',
  termsSnapshot: { providerDisplayName: 'Tamarind Bio', termsUrl: 'https://t', disclosure: 'd' },
};

it('finds matching protein runs before limiting results, across input shapes and states', () => {
  const registry = makeRegistry();
  const original = registry.recordIntent({ ...intent, settings: { protein_sequence: 'MAG' } });
  registry.markSubmitted(original.id, 'old-fold');
  registry.markImported(original.id, ['/ws/model.pdb']);
  clock += 1000;
  const complex = registry.recordIntent({
    ...intent,
    settings: {
      polymers: [
        { id: 'P', molecule_type: 'protein', sequence: 'MAG' },
        { id: 'D', molecule_type: 'dna', sequence: 'AAA' },
      ],
    },
  });
  for (let i = 0; i < 5; i++) {
    clock += 1000;
    registry.recordIntent({ ...intent, settings: { sequence: 'MWG', numModels: i + 1 } });
  }
  expect(registry.list({ proteinSequence: ' m a g * ', limit: 2 }).map((run) => run.id)).toEqual([
    complex.id,
    original.id,
  ]);
  expect(registry.list({ proteinSequence: 'AAA' })).toEqual([]);
  registry.stop();
});

describe('registry', () => {
  it('returns every old active state independently of 205 newer terminal rows and exact SQLite totals', () => {
    const reg = makeRegistry();
    const active = ['intent', 'submitted', 'queued', 'running'].map((state, index) => {
      const row = reg.recordIntent({
        ...intent,
        label: `old-${state}`,
        settings: { ...intent.settings, numModels: index + 1 },
      });
      db.prepare('UPDATE compute_jobs SET state = ? WHERE id = ?').run(state, row.id);
      return row.id;
    });
    const terminals: string[] = [];
    for (let i = 0; i < 205; i++) {
      clock += 1000;
      const row = reg.recordIntent({
        ...intent,
        label: `terminal-${i}`,
        settings: { ...intent.settings, numModels: i + 5 },
      });
      terminals.push(row.id);
      db.prepare('UPDATE compute_jobs SET state = ? WHERE id = ?').run(
        ['completed', 'failed', 'canceled', 'imported'][i % 4],
        row.id
      );
    }

    expect(reg.list().some((row) => active.includes(row.id))).toBe(false);
    const native = reg.snapshot();
    const independent = db
      .prepare('SELECT state, COUNT(*) AS n FROM compute_jobs GROUP BY state')
      .all() as Array<{ state: string; n: number }>;
    expect(independent.reduce((sum, group) => sum + group.n, 0)).toBe(209);
    expect(
      independent
        .filter((group) => ['intent', 'submitted', 'queued', 'running'].includes(group.state))
        .reduce((sum, group) => sum + group.n, 0)
    ).toBe(4);
    expect(native).toMatchObject({
      jobCount: 209,
      activeCount: 4,
      terminalCount: 205,
      activeComplete: true,
      historyComplete: false,
      historyLimit: 200,
    });
    expect(
      native.jobs
        .filter((row) => active.includes(row.id))
        .map((row) => row.id)
        .sort()
    ).toEqual([...active].sort());
    expect(native.jobs.filter((row) => !active.includes(row.id)).map((row) => row.id)).toEqual(
      terminals.slice(-200).reverse()
    );
    const smaller = reg.snapshot({ historyLimit: 1 });
    expect(smaller.jobs.map((row) => row.id).sort()).toEqual([terminals[204], ...active].sort());
    expect(smaller).toMatchObject({
      jobCount: 209,
      activeCount: 4,
      terminalCount: 205,
      historyComplete: false,
    });
    expect(reg.snapshot({ historyLimit: 205 })).toMatchObject({
      historyComplete: true,
      jobs: expect.any(Array),
    });
    expect(reg.list({ states: ['running'], limit: 1 }).map((row) => row.id)).toEqual([active[3]]);
    reg.stop();
  });

  it('qualifies empty history and an exact terminal page boundary from native counts', () => {
    const reg = makeRegistry();
    expect(reg.snapshot()).toEqual({
      jobs: [],
      jobCount: 0,
      activeCount: 0,
      terminalCount: 0,
      activeComplete: true,
      historyComplete: true,
      historyLimit: 200,
    });
    for (let i = 0; i < 200; i++) {
      const row = reg.recordIntent(intent);
      reg.markFailed(row.id, 'Synthetic terminal');
    }
    expect(reg.snapshot()).toMatchObject({
      jobCount: 200,
      activeCount: 0,
      terminalCount: 200,
      historyComplete: true,
    });
    reg.markFailed(reg.recordIntent(intent).id, 'Synthetic terminal');
    expect(reg.snapshot()).toMatchObject({
      jobCount: 201,
      activeCount: 0,
      terminalCount: 201,
      historyComplete: false,
    });
    expect(reg.snapshot().jobs).toHaveLength(200);
    reg.stop();
  });

  it('re-reads native totals after registry restart and valid state changes instead of pinning active work', () => {
    const reg = makeRegistry();
    const row = reg.recordIntent(intent);
    reg.markSubmitted(row.id, 'synthetic-remote');
    reg.stop();
    const restarted = makeRegistry();
    expect(restarted.snapshot({ historyLimit: 1 })).toMatchObject({
      activeCount: 1,
      terminalCount: 0,
      jobs: [expect.objectContaining({ id: row.id, state: 'submitted' })],
    });
    restarted.markCanceled(row.id, 'Provider confirmed');
    expect(restarted.snapshot({ historyLimit: 1 })).toMatchObject({
      activeCount: 0,
      terminalCount: 1,
      historyComplete: true,
      jobs: [expect.objectContaining({ id: row.id, state: 'canceled' })],
    });
    restarted.stop();
  });

  it('verifies a completed prediction using the public API provider identity', async () => {
    const reg = makeRegistry();
    const job = reg.recordIntent(intent);
    reg.markSubmitted(job.id, 'live-fold');
    const result = {
      ref: { provider: intent.provider, remote_id: 'live-fold', tool_id: intent.toolId },
      output_kind: 'structure',
      files: [
        {
          name: 'model.pdb',
          media_type: 'chemical/x-pdb',
          size_bytes: 4,
          content: 'ATOM',
          url: null,
        },
      ],
      metrics: {},
      provenance: { livemode: 'true' },
    };
    statusScript.push(
      { status: 200, body: { state: 'completed', provider_state: 'Complete', terminal: true } },
      { status: 200, body: result }
    );
    expect(await reg.readCompletedResult(job.id)).toMatchObject({
      job: { id: job.id, state: 'completed' },
      result,
    });
    expect(seen.map((request) => request.url)).toEqual([
      '/compute/tamarind/status',
      '/compute/tamarind/result',
    ]);
    reg.stop();
  });

  it('retains the exact inspection revision across registry restart without sending it to the provider', async () => {
    const resultTarget = {
      kind: 'protein-inspection' as const,
      documentId: 'sequence-document:clone-reference',
      proteinKey: '["cds-7","MKT"]',
      proteinSequenceSha256: 'a'.repeat(64),
      continuationReferenceId: 'durable-inspection-context',
    };
    const reg = makeRegistry();
    const job = reg.recordIntent({ ...intent, resultTarget });
    reg.markSubmitted(job.id, 'fold-for-inspection');
    reg.stop();
    const reopened = makeRegistry();
    expect(reopened.findByRemote('tamarind', 'fold-for-inspection')).toMatchObject({
      resultTarget,
      settings: intent.settings,
    });
    expect(reopened.get(job.id)?.settingsHash).toBe(settingsHash(intent.settings));
  });

  it('records an intent row before the provider is called, then marks it submitted with the remote id', () => {
    const reg = makeRegistry();
    const job = reg.recordIntent(intent);
    expect(job).toMatchObject({
      state: 'intent',
      remoteId: null,
      provider: 'tamarind',
      costEstimate: 0.4,
    });
    expect(job.settingsHash).toBe(settingsHash(intent.settings));
    const submitted = reg.markSubmitted(job.id, 'tmr-job-77');
    expect(submitted).toMatchObject({ state: 'submitted', remoteId: 'tmr-job-77' });
    expect(submitted?.nextPollAt).toBe(new Date(clock + POLL_BASE_MS).toISOString());
    expect(reg.findByRemote('tamarind', 'tmr-job-77')?.id).toBe(job.id);
  });

  it('marks a failed submit with the error and never schedules a poll', () => {
    const reg = makeRegistry();
    const job = reg.recordIntent(intent);
    const failed = reg.markFailed(job.id, 'bad_credential: rejected');
    expect(failed).toMatchObject({
      state: 'failed',
      lastError: 'bad_credential: rejected',
      nextPollAt: null,
    });
    expect(scheduled).toEqual([]);
  });

  it('observes the submitted transition and each terminal transition once', () => {
    const observed: Array<{ state: string; provider: string; toolId: string }> = [];
    const reg = makeRegistry({
      observeLifecycle: (record) =>
        observed.push({ state: record.state, provider: record.provider, toolId: record.toolId }),
    });
    const submitted = reg.recordIntent(intent);
    reg.markSubmitted(submitted.id, 'tmr-job-77');
    reg.markCanceled(submitted.id, 'Stopped');
    reg.markCanceled(submitted.id, 'Stopped twice');
    const failed = reg.recordIntent(intent);
    reg.markFailed(failed.id, 'bad_credential: rejected');
    expect(observed.map(({ state }) => state)).toEqual(['submitted', 'canceled', 'failed']);
    expect(observed[0]).toMatchObject({ provider: 'tamarind', toolId: intent.toolId });
  });

  it('persists a provider-confirmed cancellation only from an active submitted job', () => {
    const reg = makeRegistry();
    const job = reg.recordIntent(intent);
    reg.markSubmitted(job.id, 'tmr-job-77');

    expect(reg.markCanceled(job.id, 'Stopped')).toMatchObject({
      state: 'canceled',
      providerState: 'Stopped',
      nextPollAt: null,
    });
    expect(reg.markCanceled(job.id, 'Stopped twice')).toMatchObject({
      state: 'canceled',
      providerState: 'Stopped',
    });
  });

  it('lists newest first and filters by state', () => {
    const reg = makeRegistry();
    const a = reg.recordIntent(intent);
    reg.markFailed(a.id, 'x');
    clock += 1000;
    const b = reg.recordIntent({ ...intent, label: 'job-2' });
    expect(reg.list().map((j) => j.label)).toEqual(['job-2', 'job-1']);
    expect(reg.list({ states: ['intent'] }).map((j) => j.id)).toEqual([b.id]);
  });
});

describe('poller', () => {
  it('polls a submitted job with the keychain key, tracks provider state, and stops at terminal', async () => {
    const reg = makeRegistry();
    const job = reg.recordIntent(intent);
    reg.markSubmitted(job.id, 'tmr-job-1');
    statusScript.push(
      {
        status: 200,
        body: {
          state: 'queued',
          provider_state: 'In Queue',
          cost_amount: null,
          cost_unit: null,
          terminal: false,
        },
      },
      {
        status: 200,
        body: {
          state: 'running',
          provider_state: 'Running',
          cost_amount: null,
          cost_unit: null,
          terminal: false,
        },
      },
      {
        status: 200,
        body: {
          state: 'completed',
          provider_state: 'Complete',
          cost_amount: 0.37,
          cost_unit: 'weighted_hours',
          terminal: true,
        },
      }
    );
    clock += POLL_BASE_MS;
    await fire();
    expect(reg.get(job.id)).toMatchObject({
      state: 'queued',
      providerState: 'In Queue',
      pollCount: 1,
    });
    expect(seen[0]).toMatchObject({
      url: '/compute/tamarind/status',
      credential: SECRET,
      body: { remote_id: 'tmr-job-1', tool_id: 'alphafold' },
    });
    clock += POLL_BASE_MS;
    await fire();
    expect(reg.get(job.id)?.state).toBe('running');
    clock += POLL_BASE_MS;
    await fire();
    expect(reg.get(job.id)).toMatchObject({
      state: 'completed',
      costActual: 0.37,
      costActualUnit: 'weighted_hours',
      nextPollAt: null,
    });
    clock += POLL_SLOW_MS;
    await fire();
    expect(seen).toHaveLength(3);
  });

  it('backs off to the slow interval after ten minutes', async () => {
    const reg = makeRegistry();
    const job = reg.recordIntent(intent);
    reg.markSubmitted(job.id, 'tmr-job-1');
    clock += POLL_SLOW_AFTER_MS + 1;
    await fire();
    expect(reg.get(job.id)?.nextPollAt).toBe(new Date(clock + POLL_SLOW_MS).toISOString());
  });

  it('re-hydrates non-terminal rows on start and polls them', async () => {
    const first = makeRegistry();
    const job = first.recordIntent(intent);
    first.markSubmitted(job.id, 'tmr-job-1');
    first.stop();
    scheduled = [];

    const second = makeRegistry();
    second.start();
    expect(scheduled).toHaveLength(1);
    clock += POLL_BASE_MS;
    await fire();
    expect(seen).toHaveLength(1);
    expect(second.get(job.id)?.pollCount).toBe(1);
  });

  it('a 404 from the provider marks the job failed; other errors reschedule', async () => {
    const reg = makeRegistry();
    const job = reg.recordIntent(intent);
    reg.markSubmitted(job.id, 'tmr-job-1');
    statusScript.push({ status: 503, body: { detail: { error: 'provider_unavailable' } } });
    clock += POLL_BASE_MS;
    await fire();
    expect(reg.get(job.id)).toMatchObject({
      state: 'submitted',
      lastError: 'provider_unavailable',
    });
    statusScript.push({ status: 404, body: { detail: { error: 'unknown_job' } } });
    clock += POLL_BASE_MS;
    await fire();
    expect(reg.get(job.id)).toMatchObject({ state: 'failed', nextPollAt: null });
    expect(reg.get(job.id)?.lastError).toMatch(/no record/);
  });

  it('without a stored key it waits instead of failing the job', async () => {
    const reg = makeRegistry({ readCredential: async () => null });
    const job = reg.recordIntent(intent);
    reg.markSubmitted(job.id, 'tmr-job-1');
    clock += POLL_BASE_MS;
    await fire();
    expect(reg.get(job.id)).toMatchObject({
      state: 'submitted',
      lastError: 'no credential connected for this provider',
    });
    expect(seen).toEqual([]);
  });

  it('abandons a hung status request, reschedules, and later observes completion', async () => {
    const firstPoll = new AbortController();
    const sidecarFetch = vi
      .fn()
      .mockImplementationOnce(
        (_url: string | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            state: 'completed',
            provider_state: 'Complete',
            cost_amount: 0.37,
            cost_unit: 'weighted_hours',
            terminal: true,
          }),
          { status: 200 }
        )
      );
    const reg = makeRegistry({
      sidecarFetch,
      createPollAbortSignal: () => firstPoll.signal,
    });
    const job = reg.recordIntent(intent);
    reg.markSubmitted(job.id, 'tmr-job-1');
    clock += POLL_BASE_MS;

    const hungPoll = reg.pollDue();
    await vi.waitFor(() => expect(sidecarFetch).toHaveBeenCalledOnce());
    firstPoll.abort(new Error('deadline'));
    await hungPoll;
    expect(reg.get(job.id)).toMatchObject({
      state: 'submitted',
      lastError: 'provider status request timed out',
      nextPollAt: new Date(clock + POLL_BASE_MS).toISOString(),
    });

    clock += POLL_BASE_MS;
    await reg.pollDue();
    expect(reg.get(job.id)).toMatchObject({
      state: 'completed',
      providerState: 'Complete',
      nextPollAt: null,
    });
  });

  it('does not let an in-flight status poll overwrite a provider-confirmed cancellation', async () => {
    let resolveStatus: ((response: Response) => void) | undefined;
    const pendingStatus = new Promise<Response>((resolve) => {
      resolveStatus = resolve;
    });
    const sidecarFetch = vi.fn(async () => pendingStatus);
    const reg = makeRegistry({ sidecarFetch });
    const job = reg.recordIntent(intent);
    reg.markSubmitted(job.id, 'tmr-job-1');
    clock += POLL_BASE_MS;

    const polling = reg.pollDue();
    await vi.waitFor(() => expect(sidecarFetch).toHaveBeenCalledOnce());
    expect(reg.markCanceled(job.id, 'Stopped')).toMatchObject({ state: 'canceled' });
    resolveStatus?.(
      new Response(
        JSON.stringify({
          state: 'running',
          provider_state: 'Running',
          cost_amount: null,
          cost_unit: null,
          terminal: false,
        }),
        { status: 200 }
      )
    );
    await polling;

    expect(reg.get(job.id)).toMatchObject({
      state: 'canceled',
      providerState: 'Stopped',
      nextPollAt: null,
    });
  });

  it('never writes the credential into the row', async () => {
    const reg = makeRegistry();
    const job = reg.recordIntent(intent);
    reg.markSubmitted(job.id, 'tmr-job-1');
    clock += POLL_BASE_MS;
    await fire();
    const raw = JSON.stringify(db.prepare('SELECT * FROM compute_jobs').all());
    expect(raw).not.toContain(SECRET);
  });
});

describe('terminal notifications', () => {
  it('announces exactly once when a poll reaches a terminal state', async () => {
    const notifyTerminal = vi.fn();
    const reg = makeRegistry({ notifyTerminal });
    const job = reg.recordIntent(intent);
    reg.markSubmitted(job.id, 'remote-1');
    expect(notifyTerminal, 'submitted is not terminal').not.toHaveBeenCalled();

    statusScript = [
      {
        status: 200,
        body: {
          state: 'completed',
          provider_state: 'Complete',
          cost_amount: 0.02,
          cost_unit: 'weighted_hours',
          terminal: true,
        },
      },
    ];
    clock += POLL_BASE_MS;
    await reg.pollDue();

    expect(notifyTerminal).toHaveBeenCalledTimes(1);
    expect(notifyTerminal).toHaveBeenCalledWith({
      id: job.id,
      provider: 'tamarind',
      toolId: 'alphafold',
      remoteId: 'remote-1',
      label: 'job-1',
      state: 'completed',
      workspaceRoot: '/ws',
      importedPaths: [],
      lastError: null,
    });
  });

  it('says nothing while a job is still running', async () => {
    const notifyTerminal = vi.fn();
    const reg = makeRegistry({ notifyTerminal });
    const job = reg.recordIntent(intent);
    reg.markSubmitted(job.id, 'remote-1');
    statusScript = [
      {
        status: 200,
        body: {
          state: 'running',
          provider_state: 'Running',
          cost_amount: null,
          cost_unit: null,
          terminal: false,
        },
      },
    ];
    clock += POLL_BASE_MS;
    await reg.pollDue();
    expect(notifyTerminal).not.toHaveBeenCalled();
  });

  it('announces a failure, an import, and a provider that lost the job', async () => {
    const notifyTerminal = vi.fn();
    const reg = makeRegistry({ notifyTerminal });

    const failed = reg.recordIntent(intent);
    reg.markFailed(failed.id, 'provider refused the settings');
    expect(notifyTerminal).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'failed', lastError: 'provider refused the settings' })
    );

    const imported = reg.recordIntent({
      ...intent,
      sourcePath: '/ws/proteins/GFP.faa',
      sourceName: 'GFP',
    });
    expect(imported.sourcePath).toBe('/ws/proteins/GFP.faa');
    const details = {
      receipt: { schemaVersion: 2, files: ['/ws/proteins/GFP prediction.dnaforge-molecular.json'] },
      outputs: [{ name: 'scores.json', content: '{"ptm":0.8}' }],
    };
    reg.markImported(imported.id, ['/ws/proteins/GFP prediction.dnaforge-molecular.json'], details);
    expect(notifyTerminal).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'imported',
        importedPaths: ['/ws/proteins/GFP prediction.dnaforge-molecular.json'],
      })
    );
    expect(reg.get(imported.id)).toMatchObject({
      sourcePath: '/ws/proteins/GFP.faa',
      sourceName: 'GFP',
    });
    expect(reg.get(imported.id)).not.toHaveProperty('importDetails');
    expect(reg.importDetails(imported.id)).toEqual(details);

    const lost = reg.recordIntent(intent);
    reg.markSubmitted(lost.id, 'remote-gone');
    statusScript = [{ status: 404, body: { detail: { error: 'unknown_job' } } }];
    clock += POLL_BASE_MS;
    await reg.pollDue();
    expect(notifyTerminal).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: lost.id, state: 'failed' })
    );

    expect(notifyTerminal).toHaveBeenCalledTimes(3);
  });
});

describe('relocating a migrated result ', () => {
  it('repoints imported paths at the saved views and keeps existing import details', () => {
    const reg = makeRegistry();
    const job = reg.recordIntent(intent);
    reg.markSubmitted(job.id, 'remote-9');
    const folder = '/ws/compute/tamarind/remote-9';
    reg.markImported(job.id, [`${folder}/model.pdb`, `${folder}/compute-job.json`]);
    const other = reg.recordIntent({ ...intent, settings: { sequence: 'MWG' } });
    reg.markSubmitted(other.id, 'remote-other');
    const details = { receipt: { migratedFrom: 'compute/tamarind/remote-9' }, outputs: [] };

    expect(
      relocateImportedResult(db, {
        provider: 'tamarind',
        remoteId: 'remote-9',
        moved: { [`${folder}/model.pdb`]: '/ws/GFP prediction.dnaforge-molecular.json' },
        removed: [`${folder}/compute-job.json`],
        details,
        now: 5,
      })
    ).toBe(1);
    expect(reg.get(job.id)?.importedPaths).toEqual(['/ws/GFP prediction.dnaforge-molecular.json']);
    expect(reg.importDetails(job.id)).toEqual(details);
    expect(reg.get(other.id)?.importedPaths).toEqual([]);

    relocateImportedResult(db, {
      provider: 'tamarind',
      remoteId: 'remote-9',
      moved: {
        '/ws/GFP prediction.dnaforge-molecular.json': '/ws/elsewhere.dnaforge-molecular.json',
      },
      removed: [],
      details: { receipt: {}, outputs: [] },
      now: 6,
    });
    expect(reg.importDetails(job.id)).toEqual(details);
  });
});

it('different nested molecule inputs and model settings have different run digests', () => {
  const first = {
    entities: [{ type: 'protein', value: 'MAG', chain_ids: ['A'] }],
    model_options: { seed: 1 },
  };
  expect(settingsHash(first)).not.toBe(
    settingsHash({ ...first, entities: [{ ...first.entities[0], value: 'MAW' }] })
  );
  expect(settingsHash(first)).not.toBe(settingsHash({ ...first, model_options: { seed: 2 } }));
  expect(settingsHash(first)).toBe(
    settingsHash({
      model_options: { seed: 1 },
      entities: [{ chain_ids: ['A'], value: 'MAG', type: 'protein' }],
    })
  );
});
