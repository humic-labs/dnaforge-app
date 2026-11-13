



import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listTools: vi.fn(),
  getSchema: vi.fn(),
  validate: vi.fn(),
  estimate: vi.fn(),
  submit: vi.fn(),
  status: vi.fn(),
  result: vi.fn(),
  cancel: vi.fn(),
}));
const inspectionPrediction = vi.hoisted(() => ({
  prepare: vi.fn(async () => ({
    kind: 'protein-inspection',
    documentId: 'sequence-document:ref',
    proteinKey: 'protein-revision',
    proteinSequenceSha256: 'a'.repeat(64),
  })),
  workspace: vi.fn(() => '/ws'),
}));
vi.mock('../../structure-drawer/public/inspection-prediction', () => ({
  prepareInspectionPrediction: inspectionPrediction.prepare,
  inspectionPredictionWorkspaceRoot: inspectionPrediction.workspace,
}));

class FakeApiError extends Error {
  status: number;
  body: unknown;
  bodyPreview?: string;
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

vi.mock('@waypoint/api-client', () => ({
  ApiResponseParseError: class ApiResponseParseError extends Error {
    responseStatus = 200;
  },
  isApiError: (e: unknown) => e instanceof FakeApiError,
  listToolsComputeProviderIdToolsPost: api.listTools,
  getSchemaComputeProviderIdSchemaPost: api.getSchema,
  validateSettingsComputeProviderIdValidatePost: api.validate,
  estimateCostComputeProviderIdEstimatePost: api.estimate,
  submitJobComputeProviderIdSubmitPost: api.submit,
  jobStatusComputeProviderIdStatusPost: api.status,
  jobResultComputeProviderIdResultPost: api.result,
  cancelJobComputeProviderIdCancelPost: api.cancel,
}));

vi.mock('./sidecar-client', () => ({ configureSidecarApiClient: vi.fn(async () => undefined) }));

const platformBridge = vi.hoisted(() => ({
  listProviders: vi.fn(async () => [
    {
      id: 'tamarind',
      displayName: 'Tamarind Bio',
      summary: '',
      transport: 'mcp',
      authScheme: 'header',
      catalog: 'dynamic',
      jobModel: 'queue',
      cost: 'estimate',
      disclosure: 'x',
      retentionNote: 'x',
      cancellationMode: 'provider',
      cancellationNote: 'Queued or running work can be canceled.',
      docsUrl: 'https://d',
      keyPageUrl: null,
      termsUrl: 'https://t',
      privacyUrl: 'https://p',
      hasBinding: true,
      connected: true,
      lastVerifiedAt: null,
    },
  ]),
}));
const jobsBridge = vi.hoisted(() => {
  const rows = new Map<string, Record<string, unknown>>();
  const make = (id: string, patch: Record<string, unknown>) => {
    const prev = rows.get(id) ?? {};
    const next = { ...prev, ...patch, id };
    rows.set(id, next);
    return next;
  };
  return {
    rows,
    recordJobIntent: vi.fn(async (input: Record<string, unknown>) => {
      return make(`job-row-${rows.size + 1}`, {
        ...input,
        remoteId: null,
        state: 'intent',
        providerState: '',
        settingsHash: 'h',
        idempotencyKey: input.idempotencyKey ?? `dnaforge-compute-job-row-${rows.size + 1}`,
        submissionRequest: {
          schemaVersion: 1,
          provider: input.provider,
          toolId: input.toolId,
          settings: input.settings,
          files: input.files ?? {},
        },
        importedPaths: [],
        lastError: null,
        pollCount: 0,
        nextPollAt: null,
        createdAt: 'now',
        updatedAt: 'now',
      });
    }),
    markJobSubmitted: vi.fn(async (id: string, remoteId: string) =>
      make(id, { state: 'submitted', remoteId })
    ),
    markJobFailed: vi.fn(async (id: string, error: string) =>
      make(id, { state: 'failed', lastError: error })
    ),
    markJobSubmissionUnknown: vi.fn(async (id: string, error: string) =>
      make(id, { state: 'submission-unknown', lastError: error })
    ),
    markJobCanceled: vi.fn(async (id: string, providerState: string) =>
      make(id, { state: 'canceled', providerState })
    ),
    markJobImported: vi.fn(async (id: string, paths: string[]) =>
      make(id, { state: 'imported', importedPaths: paths })
    ),
    listJobs: vi.fn(async () => [...rows.values()]),
    findJob: vi.fn(
      async (provider: string, remoteId: string) =>
        [...rows.values()].find((r) => r.provider === provider && r.remoteId === remoteId) ?? null
    ),
  };
});
vi.mock('../../../platform', () => ({
  platform: () => ({ compute: { ...platformBridge, ...jobsBridge } }),
}));
vi.mock('../../compute/import-result', () => ({
  resolveComputeWorkspaceRoot: (
    folders: Array<{ path: string; pinned?: boolean }>,
    preferredRoot?: string | null
  ) => {
    const writable = folders.filter((folder) => !folder.pinned);
    return (
      writable.find((folder) => folder.path === preferredRoot)?.path ?? writable[0]?.path ?? null
    );
  },
  importComputeResult: vi.fn(async () => ({
    ok: true,
    workspaceRoot: '/ws',
    writtenPaths: ['/ws/My fold.dnaforge-molecular.json'],
    urlOnly: [],
    opened: ['/ws/My fold.dnaforge-molecular.json'],
    metrics: { plddt: 88 },
    provenance: { provider: 'tamarind' },
    predictionResultIds: [],
    catalogObservationIds: [],
    predictionLibraryWarnings: [],
    importDetails: { receipt: { schemaVersion: 2 }, outputs: [] },
  })),
}));

import { useConfirmDialogStore } from '../../../components/confirm-dialog-store';
import {
  useComputeConsentStore,
  useComputeJobsStore,
  useComputeStore,
} from '../../compute/public/agent-tools';
import {
  createComputeImportResultTool,
  createComputeSubmitTool,
  computeCancelTool,
  computeEstimateTool,
  computeGetSchemaTool,
  computeListProvidersTool,
  computeListToolsTool,
  computeStatusTool,
  computeSubmitTool,
  computeValidateTool,
} from './compute';
import { computeTools } from '../../agent-bridge/catalog/compute';
import { assertToolOperationResult } from '../../agent-bridge/public/tool-result';
import { assertMcpOutput } from '../../../test-utils/mcp-output-test-helper';

type Exec<T> = (args: T, ctx: Record<string, unknown>) => Promise<unknown>;
const run = async <T>(t: { execute?: unknown }, args: T, ctx: Record<string, unknown> = {}) => {
  const result = await (t.execute as Exec<T>)(args, {
    grantedCapabilities: ['external-compute:discover', 'external-compute:submit'],
    toolCallId: 'act-1',
    workspaceRoot: '/ws',
    ...ctx,
  });
  assertToolOperationResult(result);
  return result;
};

const submitArgs = {
  provider: 'tamarind',
  tool_id: 'alphafold',
  settings: { sequence: 'MKTAYIAKQR' },
  label: 'job-1',
  estimated_cost: { amount: 0.4, unit: 'weighted_hours' },
};

beforeEach(() => {
  inspectionPrediction.workspace.mockReset().mockReturnValue('/ws');
  for (const fn of Object.values(api)) fn.mockReset();
  useComputeConsentStore.getState().resetForTests();
  useComputeJobsStore.getState().resetForTests();
  jobsBridge.rows.clear();
  for (const fn of [
    jobsBridge.recordJobIntent,
    jobsBridge.markJobSubmitted,
    jobsBridge.markJobFailed,
    jobsBridge.markJobSubmissionUnknown,
    jobsBridge.markJobImported,
    jobsBridge.findJob,
  ])
    fn.mockClear();
  useComputeStore.setState({
    providers: [],
    pendingConnectProviderId: null,
    connectDialog: { open: false, providerId: null },
  });
  useConfirmDialogStore.setState({ request: null });
  api.submit.mockResolvedValue({
    status: 200,
    data: { provider: 'tamarind', remote_id: 'job-1', tool_id: 'alphafold', artifact_refs: [] },
  });
});

async function answerConfirm(confirmed: boolean) {
  await vi.waitFor(() => {
    expect(useConfirmDialogStore.getState().request).not.toBeNull();
  });
  useConfirmDialogStore.getState().resolveCurrent(confirmed);
}

describe('compute.submit gate', () => {
  it('binds an inspection prediction to its reference workspace even when another writable root comes first', async () => {
    const boundTool = createComputeSubmitTool([
      { path: '/unrelated', name: 'Unrelated project', addedAt: 1 },
      { path: '/ws', name: 'Reference project', addedAt: 2 },
    ]);
    const pending = run(boundTool, {
      ...submitArgs,
      inspection_target: { document_id: 'sequence-document:ref' },
    });
    await answerConfirm(true);
    expect(await pending).toMatchObject({ ok: true });
    expect(jobsBridge.recordJobIntent).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/ws' })
    );
  });

  it.each([
    { extraFolders: [] },
    { extraFolders: [{ path: '/ws', name: 'Read-only reference', addedAt: 1, pinned: true }] },
  ])(
    'refuses an unavailable inspection workspace before consent or provider submission',
    async ({ extraFolders }) => {
      useComputeConsentStore.getState().recordConfirmation('tamarind');
      const boundTool = createComputeSubmitTool([
        { path: '/unrelated', name: 'Unrelated project', addedAt: 1 },
        ...extraFolders,
      ]);
      expect(
        await run(boundTool, {
          ...submitArgs,
          inspection_target: { document_id: 'sequence-document:ref' },
        })
      ).toMatchObject({ ok: false, code: 'inspection_destination_unavailable' });
      expect(jobsBridge.recordJobIntent).not.toHaveBeenCalled();
      expect(api.submit).not.toHaveBeenCalled();
      expect(useConfirmDialogStore.getState().request).toBeNull();
    }
  );

  it('persists the inspection destination before submit and never includes it in provider settings', async () => {
    const pending = run(computeSubmitTool, {
      ...submitArgs,
      inspection_target: { document_id: 'sequence-document:ref' },
    });
    await answerConfirm(true);
    expect(await pending).toMatchObject({ ok: true });
    expect(jobsBridge.recordJobIntent.mock.calls[0][0]).toMatchObject({
      resultTarget: { kind: 'protein-inspection', documentId: 'sequence-document:ref' },
    });
    expect(api.submit.mock.calls[0][1]).not.toHaveProperty('inspection_target');
    expect(api.submit.mock.calls[0][1].settings).toEqual(submitArgs.settings);
  });

  it('does not spend provider budget when the frozen request cannot be recorded durably', async () => {
    jobsBridge.recordJobIntent.mockRejectedValueOnce(new Error('database unavailable'));
    const pending = run(computeSubmitTool, {
      ...submitArgs,
      inspection_target: { document_id: 'sequence-document:ref' },
    });
    await answerConfirm(true);
    expect(await pending).toMatchObject({
      ok: false,
      code: 'request_not_retained',
      stateChanged: false,
    });
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('binds the active writable workspace into intents created through the renderer bridge', async () => {
    const boundTool = createComputeSubmitTool([
      { path: '/refs/pinned', name: 'Reference', addedAt: 1, pinned: true },
      { path: '/ws/current', name: 'Current', addedAt: 2 },
    ]);
    const pending = run(boundTool, submitArgs);
    await answerConfirm(true);
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(jobsBridge.recordJobIntent).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRoot: '/ws/current' })
    );
  });

  it('asks once on the first submit, names the destination and cost, and does not call the sidecar until confirmed', async () => {
    const pending = run(computeSubmitTool, submitArgs, { workspaceRoot: '/ws/lab' });
    await vi.waitFor(() => expect(useConfirmDialogStore.getState().request).not.toBeNull());
    expect(api.submit).not.toHaveBeenCalled();
    const request = useConfirmDialogStore.getState().request!;
    expect(request.title).toBe('Send a job to Tamarind?');
    expect(request.message).toContain('Sequences: 1 (10 residues)');
    expect(request.message).toContain('Estimated cost: 0.4 weighted hours');
    expect(request.message).not.toContain('MKTAYIAKQR');
    expect(request.safeDefault).toBe(true);
    useConfirmDialogStore.getState().resolveCurrent(true);
    const result = (await pending) as { ok: boolean; job: { remote_id: string } };
    expect(result.ok).toBe(true);
    expect(result.job.remote_id).toBe('job-1');
    expect(api.submit).toHaveBeenCalledTimes(1);
    expect(api.submit.mock.calls[0][1]).toMatchObject({
      granted_capabilities: ['external-compute:discover', 'external-compute:submit'],
      tool_id: 'alphafold',
      settings: { sequence: 'MKTAYIAKQR' },
      label: 'job-1',
      action_id: 'act-1',
    });

    expect(jobsBridge.recordJobIntent).toHaveBeenCalledTimes(1);
    expect(jobsBridge.recordJobIntent.mock.calls[0][0]).toMatchObject({
      provider: 'tamarind',
      toolId: 'alphafold',
      costEstimate: 0.4,
      workspaceRoot: '/ws/lab',
    });
    expect(jobsBridge.recordJobIntent.mock.invocationCallOrder[0]).toBeLessThan(
      api.submit.mock.invocationCallOrder[0]
    );
    expect(jobsBridge.markJobSubmitted).toHaveBeenCalledWith('job-row-1', 'job-1');
    expect(useComputeJobsStore.getState().jobs[0]).toMatchObject({
      remoteId: 'job-1',
      state: 'submitted',
    });
  });

  it('words the confirmation for a job the user started rather than the agent', async () => {
    const pending = run(computeSubmitTool, submitArgs, { initiator: 'user' });
    await vi.waitFor(() => expect(useConfirmDialogStore.getState().request).not.toBeNull());
    expect(useConfirmDialogStore.getState().request?.message).toMatch(
      /^You are about to run “AlphaFold” on Tamarind with Sequences: 1/
    );
    useConfirmDialogStore.getState().resolveCurrent(false);
    await pending;
  });

  it('keeps unknown internal tool keys out of the confirmation', async () => {
    const pending = run(computeSubmitTool, { ...submitArgs, tool_id: 'internal_model_v7' });
    await vi.waitFor(() => expect(useConfirmDialogStore.getState().request).not.toBeNull());
    expect(useConfirmDialogStore.getState().request?.message).toContain('“Compute job”');
    expect(useConfirmDialogStore.getState().request?.message).not.toContain('internal_model_v7');
    useConfirmDialogStore.getState().resolveCurrent(false);
    await pending;
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('a decline returns user_declined, submits nothing, records nothing, and the next submit asks again', async () => {
    const pending = run(computeSubmitTool, submitArgs);
    await answerConfirm(false);
    const result = (await pending) as { ok: boolean; error: string; next: string };
    expect(result).toMatchObject({ ok: false, error: 'user_declined' });
    expect(result.next).toMatch(/Do not resubmit/);
    expect(api.submit).not.toHaveBeenCalled();
    expect(jobsBridge.recordJobIntent).not.toHaveBeenCalled();
    expect(useComputeConsentStore.getState().needsConfirmation('tamarind', 0.4)).toBe(true);
  });

  it('the second submit within budget does not prompt; over budget prompts again', async () => {
    const first = run(computeSubmitTool, submitArgs);
    await answerConfirm(true);
    await first;

    const second = (await run(computeSubmitTool, { ...submitArgs, label: 'job-2' })) as {
      ok: boolean;
    };
    expect(second.ok).toBe(true);
    expect(useConfirmDialogStore.getState().request).toBeNull();

    const big = run(computeSubmitTool, {
      ...submitArgs,
      label: 'job-3',
      estimated_cost: { amount: 50, unit: 'weighted_hours' },
    });
    await answerConfirm(true);
    expect(((await big) as { ok: boolean }).ok).toBe(true);
    expect(api.submit).toHaveBeenCalledTimes(3);
  });

  it('read-only tools never prompt', async () => {
    api.listTools.mockResolvedValue({
      status: 200,
      data: {
        provider: 'tamarind',
        tools: [
          {
            id: 'alphafold',
            display_name: 'AF2',
            description: '',
            tags: [],
            output_kind: 'structure',
          },
        ],
      },
    });
    const result = (await run(computeListToolsTool, { provider: 'tamarind', search: 'fold' })) as {
      ok: boolean;
      tools: unknown[];
    };
    expect(result.ok).toBe(true);
    expect(result.tools).toHaveLength(1);
    expect(useConfirmDialogStore.getState().request).toBeNull();
  });
});

describe('error contract', () => {
  it('missing_credential raises the connect chip for that provider and tells the model to ask, not retry', async () => {
    api.listTools.mockRejectedValue(
      new FakeApiError(401, {
        detail: {
          error: 'missing_credential',
          provider: 'tamarind',
          header: 'X-DNAForge-Compute-Credential',
        },
      })
    );
    const result = (await run(computeListToolsTool, { provider: 'tamarind' })) as {
      ok: boolean;
      error: string;
      next: string;
      message: string;
    };
    expect(result).toMatchObject({ ok: false, error: 'missing_credential', provider: 'tamarind' });
    expect(result.next).toMatch(/Connect Tamarind/);
    expect(result.next).toMatch(/Do not ask the user to paste the key into chat/);
    expect(useComputeStore.getState().pendingConnectProviderId).toBe('tamarind');
  });

  it('maps provider failure kinds to plain language plus the provider message', async () => {
    useComputeStore.setState({
      providers: [{ id: 'tamarind', displayName: 'Tamarind Bio' } as never],
    });
    api.listTools.mockRejectedValue(
      new FakeApiError(402, {
        detail: { error: 'budget_exhausted', provider: 'tamarind', message: 'org budget exceeded' },
      })
    );
    const result = (await run(computeListToolsTool, { provider: 'tamarind' })) as {
      error: string;
      message: string;
      next: string;
    };
    expect(result.error).toBe('budget_exhausted');
    expect(result.message).toContain(
      "Tamarind Bio says this account's budget or credits are used up"
    );
    expect(result.message).toContain('org budget exceeded');
    expect(result.next).toMatch(/Stop submitting/);
    expect(useComputeStore.getState().pendingConnectProviderId).toBeNull();
  });

  it('a capability denial is reported, not retried', async () => {
    api.listTools.mockRejectedValue(
      new FakeApiError(403, {
        detail: {
          error: 'capability_denied',
          required: ['external-compute:discover'],
          granted: [],
        },
      })
    );
    const result = (await run(computeListToolsTool, { provider: 'tamarind' })) as {
      error: string;
      next: string;
    };
    expect(result.error).toBe('capability_denied');
    expect(result.next).toMatch(/not allowed/);
  });

  it('rethrows non-API errors (our own bugs are not dressed up as provider failures)', async () => {
    api.listTools.mockRejectedValue(new TypeError('boom'));
    await expect(run(computeListToolsTool, { provider: 'tamarind' })).rejects.toThrow('boom');
  });
});

describe('compute.listProviders / compute.importResult', () => {
  it('listProviders reports connection state from main and refreshes the store', async () => {
    const result = (await run(computeListProvidersTool, {})) as {
      ok: boolean;
      providers: Array<{ id: string; connected: boolean }>;
      next: string;
    };
    expect(result.providers).toEqual([
      expect.objectContaining({ id: 'tamarind', connected: true, hasBinding: true }),
    ]);
    expect(result.next).toMatch(/compute.listTools/);
    expect(useComputeStore.getState().providers[0]?.id).toBe('tamarind');
  });

  it('importResult fetches the bundle, lands it in the workspace, marks the job imported, and reports what opened', async () => {
    await jobsBridge.recordJobIntent({
      provider: 'tamarind',
      toolId: 'alphafold',
      label: 'My fold',
      settings: {},
      costEstimate: null,
      costEstimateUnit: null,
      workspaceRoot: null,
      termsSnapshot: null,
    });
    await jobsBridge.markJobSubmitted('job-row-1', 'job-1');
    api.result.mockResolvedValue({
      status: 200,
      data: {
        ref: { provider: 'tamarind', remote_id: 'job-1', tool_id: 'alphafold', artifact_refs: [] },
        output_kind: 'structure',
        files: [
          {
            name: 'm.pdb',
            media_type: 'chemical/x-pdb',
            size_bytes: null,
            content: 'ATOM',
            url: null,
          },
        ],
        metrics: { plddt: 88 },
        provenance: { provider: 'tamarind' },
      },
    });
    const tool = createComputeImportResultTool([{ path: '/ws', name: 'ws', addedAt: 1 }]);
    const result = (await run(tool, {
      provider: 'tamarind',
      remote_id: 'job-1',
      tool_id: 'alphafold',
    })) as {
      ok: boolean;
      written_paths: string[];
      opened: string[];
      metrics: Record<string, unknown>;
      next: string;
    };
    expect(result.ok).toBe(true);
    expect(result.written_paths).toEqual(['/ws/My fold.dnaforge-molecular.json']);
    expect(result.opened).toEqual(['/ws/My fold.dnaforge-molecular.json']);
    expect(result.metrics).toEqual({ plddt: 88 });
    expect(result.next).toMatch(/do not turn them into a yes\/no verdict/);
    expect(jobsBridge.markJobImported).toHaveBeenCalledWith('job-row-1', result.written_paths, {
      receipt: { schemaVersion: 2 },
      outputs: [],
    });
  });

  it('retains uncertain submission after a provider budget error without a confirmed acknowledgement', async () => {
    api.submit.mockRejectedValueOnce(
      new FakeApiError(402, {
        detail: { error: 'budget_exhausted', provider: 'tamarind', message: 'no budget' },
      })
    );
    const pending = run(computeSubmitTool, submitArgs);
    await answerConfirm(true);
    const result = (await pending) as { ok: boolean; error: string };
    expect(result).toMatchObject({ ok: false, error: 'budget_exhausted', retriable: false, stateChanged: 'unknown' });
    expect(jobsBridge.markJobSubmissionUnknown).toHaveBeenCalledWith(
      'job-row-1',
      expect.stringContaining('budget_exhausted')
    );
    expect(jobsBridge.markJobFailed).not.toHaveBeenCalled();
  });
});

describe('compute.cancel', () => {
  const ref = { provider: 'tamarind', remote_id: 'job-1', tool_id: 'esmfold' };

  it('stops the job through the sidecar, reports the provider state, and never prompts', async () => {
    api.cancel.mockResolvedValue({
      status: 200,
      data: {
        ref: { provider: 'tamarind', remote_id: 'job-1', tool_id: 'esmfold' },
        state: 'canceled',
        provider_state: 'Stopped',
        progress_note: '',
        cost_amount: null,
        cost_unit: null,
        terminal: true,
      },
    });

    const result = await run(computeCancelTool, ref);

    expect(result).toMatchObject({ ok: true, state: 'canceled', terminal: true });
    expect(api.cancel).toHaveBeenCalledTimes(1);

    expect(useConfirmDialogStore.getState().request).toBeNull();
  });

  it('reports a provider that cannot cancel instead of claiming the job stopped', async () => {
    useComputeStore.setState({
      providers: [{ id: 'boltz', displayName: 'Boltz' } as never],
    });
    api.cancel.mockRejectedValue(
      new FakeApiError(502, {
        detail: {
          error: 'provider_error',
          provider: 'boltz',
          message: 'boltz: provider has no cancel tool',
        },
      })
    );

    const result = (await run(computeCancelTool, {
      provider: 'boltz',
      remote_id: 'p-1',
      tool_id: 'boltz-2',
    })) as { ok: boolean; error: string; message: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe('provider_error');
    expect(result.message).toContain('no cancel tool');
  });
});

describe('compute MCP output contracts', () => {
  const ref = { provider: 'tamarind', remote_id: 'job-1', tool_id: 'alphafold', artifact_refs: [] };
  const status = {
    ref,
    state: 'completed',
    provider_state: 'Complete',
    progress_note: '',
    cost_amount: null,
    cost_unit: null,
    terminal: true,
  };
  const resultBundle = {
    ref,
    output_kind: 'structure',
    files: [
      { name: 'm.pdb', media_type: 'chemical/x-pdb', size_bytes: null, content: 'ATOM', url: null },
    ],
    metrics: { plddt: 88 },
    provenance: { provider: 'tamarind' },
  };

  it.each([
    {
      name: 'compute.listProviders' as const,
      execute: () => run(computeListProvidersTool, {}),
      invalidPath: ['providers', 0, 'connected'],
      invalidValue: 'yes',
    },
    {
      name: 'compute.listTools' as const,
      execute: () => {
        api.listTools.mockResolvedValue({
          status: 200,
          data: {
            provider: 'tamarind',
            tools: [
              {
                id: 'alphafold',
                display_name: 'AlphaFold',
                description: '',
                tags: ['fold'],
                output_kind: 'structure',
              },
            ],
          },
        });
        return run(computeListToolsTool, { provider: 'tamarind' });
      },
      invalidPath: ['tools', 0, 'tags', 0],
      invalidValue: 42,
    },
    {
      name: 'compute.getSchema' as const,
      execute: () => {
        api.getSchema.mockResolvedValue({
          status: 200,
          data: {
            provider: 'tamarind',
            tool_id: 'alphafold',
            schema: {
              type: 'object',
              properties: {
                sequence: { type: 'string' },
                flags: { type: 'array', items: { type: 'boolean' } },
              },
              required: ['sequence'],
              additionalProperties: false,
            },
          },
        });
        return run(computeGetSchemaTool, { provider: 'tamarind', tool_id: 'alphafold' });
      },
      invalidPath: ['schema'],
      invalidValue: [],
    },
    {
      name: 'compute.validate' as const,
      execute: () => {
        api.validate.mockResolvedValue({
          status: 200,
          data: {
            provider: 'tamarind',
            tool_id: 'alphafold',
            ok: false,
            problems: ['sequence is required'],
          },
        });
        return run(computeValidateTool, {
          provider: 'tamarind',
          tool_id: 'alphafold',
          settings: {},
        });
      },
      invalidPath: ['problems'],
      invalidValue: [42],
    },
    {
      name: 'compute.estimate' as const,
      execute: () => {
        api.estimate.mockResolvedValue({
          status: 200,
          data: {
            provider: 'tamarind',
            tool_id: 'alphafold',
            amount: null,
            unit: 'credits',
            estimated_seconds: null,
            note: 'Unknown until complete',
            known: false,
          },
        });
        return run(computeEstimateTool, {
          provider: 'tamarind',
          tool_id: 'alphafold',
          settings: {},
        });
      },
      invalidPath: ['amount'],
      invalidValue: 'unknown',
    },
    {
      name: 'compute.submit' as const,
      execute: () => {
        useComputeConsentStore.getState().recordConfirmation('tamarind');
        return run(createComputeSubmitTool([{ path: '/ws', name: 'ws', addedAt: 1 }]), submitArgs);
      },
      invalidPath: ['job', 'remote_id'],
      invalidValue: 42,
    },
    {
      name: 'compute.status' as const,
      execute: () => {
                                                                   
        api.status.mockResolvedValue({ status: 200, data: { ...status, state: 'failed' } });
        return run(computeStatusTool, ref);
      },
      invalidPath: ['state'],
      invalidValue: 'invented',
    },
    {
      name: 'compute.cancel' as const,
      execute: () => {
        api.cancel.mockResolvedValue({ status: 200, data: { ...status, state: 'canceled' } });
        return run(computeCancelTool, ref);
      },
      invalidPath: ['terminal'],
      invalidValue: 'yes',
    },
    {
      name: 'compute.importResult' as const,
      execute: () => {
        api.result.mockResolvedValue({ status: 200, data: resultBundle });
        return run(createComputeImportResultTool([{ path: '/ws', name: 'ws', addedAt: 1 }]), ref);
      },
      invalidPath: ['url_only'],
      invalidValue: [{ name: 42, url: 'https://provider.test/file' }],
    },
  ])(
    '$name validates real factory data and rejects a malformed nested receipt',
    async ({ name, execute, invalidPath, invalidValue }) => {
      const definition = computeTools[name];
      expect(definition.execution.resultContract).toBe('explicit-v1');
      const factory = definition.execution.createTool({
        folders: [],
        actionId: 'contract-test',
        grantedCapabilities: [],
      });
      expect(factory).toHaveProperty('resultContract', 'explicit-v1');
      const result = await execute();
      expect(result).toMatchObject({ ok: true });
      assertMcpOutput(definition.outputSchema, result);
      const malformed = JSON.parse(JSON.stringify(result));
      let target = malformed as Record<string | number, unknown>;
      for (const key of invalidPath.slice(0, -1))
        target = target[key] as Record<string | number, unknown>;
      target[invalidPath[invalidPath.length - 1]] = invalidValue;
      expect(() => assertMcpOutput(definition.outputSchema, malformed)).toThrow(
        'MCP output contract rejected factory data'
      );
    }
  );

  it('empty provider and tool discovery are successful results', async () => {
    platformBridge.listProviders.mockResolvedValueOnce([]);
    const providers = await run(computeListProvidersTool, {});
    expect(providers).toMatchObject({ ok: true, providers: [] });
    assertMcpOutput(computeTools['compute.listProviders'].outputSchema, providers);
    api.listTools.mockResolvedValue({ status: 200, data: { provider: 'tamarind', tools: [] } });
    const tools = await run(computeListToolsTool, { provider: 'tamarind' });
    expect(tools).toMatchObject({ ok: true, tools: [] });
    assertMcpOutput(computeTools['compute.listTools'].outputSchema, tools);
  });
});
