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
    writtenPaths: [
      '/ws/compute/tamarind/job-1/m.pdb',
      '/ws/compute/tamarind/job-1/compute-job.json',
    ],
    urlOnly: [],
    opened: ['/ws/compute/tamarind/job-1/m.pdb'],
    metrics: { plddt: 88 },
    provenance: { provider: 'tamarind' },
    predictionResultIds: [],
    catalogObservationIds: [],
    predictionLibraryWarnings: [],
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

describe('compute submission budget ownership', () => {
  it.each(['job cap', 'cost cap'] as const)(
    'rechecks the %s after an overlapping submission is acknowledged',
    async (limit) => {
      useComputeConsentStore
        .getState()
        .setBudget(
          limit === 'job cap' ? { maxJobs: 1, maxCost: 100 } : { maxJobs: 100, maxCost: 0.6 }
        );
      useComputeConsentStore.getState().recordConfirmation('tamarind');
      let acknowledge!: (value: unknown) => void;
      const response = {
        status: 200,
        data: {
          provider: 'tamarind',
          remote_id: 'first-job',
          tool_id: 'alphafold',
          artifact_refs: [],
        },
      };
      api.submit.mockReturnValueOnce(
        new Promise((resolve) => {
          acknowledge = resolve;
        })
      );
      const first = run(computeSubmitTool, submitArgs);
      await vi.waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
      const second = run(computeSubmitTool, {
        ...submitArgs,
        settings: { sequence: 'MKKLLAA' },
        label: 'different-job',
      });
      try {
        acknowledge(response);
        await first;
        await vi.waitFor(() => expect(useConfirmDialogStore.getState().request).not.toBeNull());
        expect(api.submit).toHaveBeenCalledTimes(1);
        useConfirmDialogStore.getState().resolveCurrent(false);
        await expect(second).resolves.toMatchObject({ ok: false, error: 'user_declined' });
        expect(jobsBridge.recordJobIntent).toHaveBeenCalledTimes(1);
      } finally {
        acknowledge(response);
        useConfirmDialogStore.getState().resolveCurrent(false);
        await Promise.allSettled([first, second]);
      }
    }
  );
});
