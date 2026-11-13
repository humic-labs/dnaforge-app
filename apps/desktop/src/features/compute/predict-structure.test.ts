import { toUserMessage } from '@waypoint/user-messages';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../structure-drawer/public/inspection-prediction', () => ({
  inspectionPredictionWorkspaceRoot: vi.fn(async () => '/ws/lab'),
}));

vi.mock('../ai/tools/compute', () => ({
  computeValidateTool: {},
  computeEstimateTool: {},
  computeSubmitTool: {},
  computeStatusTool: {},
  createComputeImportResultTool: () => ({}),
}));
vi.mock('../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));

import type { ComputeProviderSummary } from '../../shared/compute-ipc';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import {
  STRUCTURE_PREDICTION_PRESETS,
  cleanProteinSequence,
  importCompletedJob,
  predictionOptions,
  runStructurePrediction,
  type PredictionDeps,
  PREDICTION_NOTICES,
} from './predict-structure';

const folders: WorkspaceFolder[] = [{ path: '/ws/lab', name: 'lab', addedAt: 1 }];

function presetFor(id: string) {
  const found = STRUCTURE_PREDICTION_PRESETS.find((p) => p.provider === id);
  if (!found) throw new Error(`no preset for ${id}`);
  return found;
}

function provider(id: string, patch: Partial<ComputeProviderSummary> = {}): ComputeProviderSummary {
  return {
    id,
    displayName: id,
    hasBinding: true,
    connected: false,
    ...patch,
  } as unknown as ComputeProviderSummary;
}

type Call = { args: Record<string, unknown>; context: unknown };
type StatusStep = { ok: boolean; terminal: boolean; state: string };

function fakeDeps(overrides: Partial<PredictionDeps> = {}) {
  const calls: Record<'validate' | 'estimate' | 'submit' | 'status' | 'import', Call[]> = {
    validate: [],
    estimate: [],
    submit: [],
    status: [],
    import: [],
  };
  const notes: Array<{ message: string; type: string }> = [];
  const sleeps: number[] = [];
  const importRoots: Array<string | null> = [];
  let script: StatusStep[] = [
    { ok: true, terminal: false, state: 'running' },
    { ok: true, terminal: true, state: 'completed' },
  ];
  let id = 0;
  const deps: PredictionDeps = {
    validate: async (args, context) => {
      calls.validate.push({ args, context });
      return { ok: true, valid: true, problems: [] };
    },
    estimate: async (args, context) => {
      calls.estimate.push({ args, context });
      return { ok: true, amount: 0.025, unit: 'USD' };
    },
    submit: async (args, context) => {
      calls.submit.push({ args, context });
      return {
        ok: true,
        job: { provider: args.provider, remote_id: 'job-1', tool_id: args.tool_id },
      };
    },
    status: async (args, context) => {
      calls.status.push({ args, context });
      return script.length > 1 ? script.shift() : script[0];
    },
    importResult: (_folders, preferredRoot) => async (args, context) => {
      importRoots.push(preferredRoot);
      calls.import.push({ args, context });
      return { ok: true };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    notify: (message, type) => {
      notes.push({ message, type });
    },
    newId: () => `id-${++id}`,
    ...overrides,
  };
  return {
    deps,
    calls,
    notes,
    sleeps,
    importRoots,
    setStatus: (steps: StatusStep[]) => {
      script = steps;
    },
  };
}

describe('structure prediction presets', () => {
  it("builds each provider's own settings for one protein chain", () => {
    expect(presetFor('boltz').settings('MKT')).toEqual({ sequence: 'MKT' });
    expect(presetFor('nvidia-nim').settings('MKT')).toEqual({
      polymers: [{ id: 'A', molecule_type: 'protein', sequence: 'MKT' }],
    });
    expect(presetFor('subseq').settings('MKT')).toEqual({ protein_sequence: 'MKT' });
    expect(presetFor('tamarind')).toMatchObject({ toolId: 'esmfold', model: 'ESMFold' });
    expect(cleanProteinSequence('mkt vla*\n')).toBe('MKTVLA');
  });

  it('offers only bound providers, marks connected ones ready, and keeps preference order', () => {
    const options = predictionOptions([
      provider('subseq', { connected: true }),
      provider('boltz'),
      provider('tamarind', { hasBinding: false }),
    ]);
    expect(options.map((o) => [o.preset.provider, o.ready])).toEqual([
      ['boltz', false],
      ['subseq', true],
    ]);
  });
});

describe('runStructurePrediction', () => {
  it('uses the inspected reference’s owner for human prediction with two projects open', async () => {
    const f = fakeDeps();
    const outcome = await runStructurePrediction(
      {
        sequence: 'MAG',
        name: 'Reference',
        inspectionTarget: { document_id: 'ref', protein_key: 'cds' },
      },
      presetFor('tamarind'),
      [{ path: '/unrelated', name: 'Unrelated', addedAt: 0 }, ...folders],
      f.deps
    );
    expect(outcome.status).toBe('submitted');
    if (outcome.status === 'submitted') await outcome.done;
    expect(f.calls.submit[0].context).toMatchObject({ workspaceRoot: '/ws/lab' });
    expect(f.calls.submit[0].args).toMatchObject({
      inspection_target: { document_id: 'ref', protein_key: 'cds' },
    });
  });
  it('validates, estimates, submits as the user, waits, then imports into the preferred root', async () => {
    const f = fakeDeps();
    const outcome = await runStructurePrediction(
      { sequence: 'mkt vla', name: 'Ubiquitin', preferredRoot: '/ws/lab/ubq.faa' },
      presetFor('boltz'),
      folders,
      f.deps
    );
    if (outcome.status !== 'submitted') throw new Error(`expected a submit, got ${outcome.status}`);
    await outcome.done;
    expect(f.calls.validate[0].args).toEqual({
      provider: 'boltz',
      tool_id: 'boltz-2',
      settings: { sequence: 'MKTVLA' },
    });
    const submit = f.calls.submit[0];
    expect(submit.args).toMatchObject({
      label: 'Ubiquitin · Boltz-2 · id-2',
      estimated_cost: { amount: 0.025, unit: 'USD' },
    });
    expect(String(submit.args.idempotency_key)).toMatch(/^dnaforge-predict-/);
    expect(submit.context).toMatchObject({
      initiator: 'user',
      grantedCapabilities: ['external-compute:discover', 'external-compute:submit'],
      workspaceRoot: '/ws/lab',
      sourcePath: '/ws/lab/ubq.faa',
      sourceName: 'Ubiquitin',
    });
    expect(f.sleeps).toEqual([15_000]);
    expect(f.calls.import[0].args).toEqual({
      provider: 'boltz',
      remote_id: 'job-1',
      tool_id: 'boltz-2',
    });
    expect(f.importRoots).toEqual(['/ws/lab/ubq.faa']);
    expect(f.notes.map((n) => n.type)).toEqual(['info', 'success']);
  });

  it("gives repeated predictions distinct provider job names within Tamarind's limit", async () => {
    const f = fakeDeps();
    const request = { sequence: 'MKT', name: 'Ubiquitin' };
    const first = await runStructurePrediction(request, presetFor('tamarind'), folders, f.deps);
    const second = await runStructurePrediction(request, presetFor('tamarind'), folders, f.deps);
    if (first.status !== 'submitted' || second.status !== 'submitted') {
      throw new Error('expected both predictions to submit');
    }
    const labels = f.calls.submit.map(({ args }) => String(args.label));
    expect(labels[0]).not.toBe(labels[1]);
    expect(labels.every((label) => label.length <= 100)).toBe(true);
    await Promise.all([first.done, second.done]);
  });

  it('stops quietly when the user declines the confirmation', async () => {
    const status = vi.fn();
    const f = fakeDeps({
      submit: async () => ({ ok: false, error: 'user_declined', message: 'declined' }),
      status,
    });
    const outcome = await runStructurePrediction(
      { sequence: 'MKT', name: 'P' },
      presetFor('boltz'),
      folders,
      f.deps
    );
    expect(outcome).toEqual({ status: 'declined' });
    expect(status).not.toHaveBeenCalled();
    expect(f.notes).toEqual([]);
  });

  it("reports the provider's validation problems without submitting", async () => {
    const submit = vi.fn();
    const f = fakeDeps({
      validate: async () => ({ ok: true, valid: false, problems: ['protein_sequence: required'] }),
      submit,
    });
    const outcome = await runStructurePrediction(
      { sequence: 'MKT', name: 'P' },
      presetFor('subseq'),
      folders,
      f.deps
    );
    const message = 'ESMFold rejected these settings: protein_sequence: required';
    expect(outcome).toEqual({ status: 'failed', message });
    expect(submit).not.toHaveBeenCalled();
    expect(f.notes).toEqual([{ message, type: 'error' }]);
  });

  it('tells the user when the job fails and imports nothing', async () => {
    const f = fakeDeps();
    f.setStatus([{ ok: true, terminal: true, state: 'failed' }]);
    const outcome = await runStructurePrediction(
      { sequence: 'MKT', name: 'P' },
      presetFor('nvidia-nim'),
      folders,
      f.deps
    );
    if (outcome.status !== 'submitted') throw new Error('expected a submit');
    await outcome.done;
    expect(f.calls.import).toHaveLength(0);
    expect(f.notes.at(-1)).toEqual({
      message: 'The Boltz-2 prediction for P ended as failed.',
      type: 'error',
    });
  });

  it('refuses an empty sequence before calling the provider', async () => {
    const validate = vi.fn();
    const f = fakeDeps({ validate });
    const outcome = await runStructurePrediction(
      { sequence: '  *', name: 'P' },
      presetFor('boltz'),
      folders,
      f.deps
    );
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(validate).not.toHaveBeenCalled();
  });
});

describe('importCompletedJob', () => {
  it('imports a finished job from the jobs list into its recorded workspace', async () => {
    const f = fakeDeps();
    const ok = await importCompletedJob(
      {
        provider: 'boltz',
        remoteId: 'job-9',
        toolId: 'boltz-2',
        workspaceRoot: '/ws/lab',
        label: 'Ubiquitin · Boltz-2',
      },
      folders,
      f.deps
    );
    expect(ok).toBe(true);
    expect(f.importRoots).toEqual(['/ws/lab']);
    expect(f.notes).toEqual([
      { message: 'Ubiquitin · Boltz-2 is saved in your workspace.', type: 'success' },
    ]);
    expect(
      await importCompletedJob(
        { provider: 'boltz', remoteId: null, toolId: 'boltz-2' },
        folders,
        f.deps
      )
    ).toBe(false);
  });
});

describe('prediction notices', () => {
  it('shows the approved notice for each outcome instead of a generic failure', () => {
    expect(toUserMessage('Predicting the structure of GFP.', PREDICTION_NOTICES.info)).toBe(
      'Structure prediction submitted. The result will be imported when it finishes.'
    );
    expect(
      toUserMessage('The predicted structure of GFP is saved.', PREDICTION_NOTICES.success)
    ).toBe('The predicted structure is saved in your workspace.');
    expect(toUserMessage('provider said no', PREDICTION_NOTICES.error)).toBe(
      'The structure prediction failed. Please review the job and try again.'
    );
  });
});
