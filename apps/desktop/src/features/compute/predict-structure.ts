import { toUserMessage, type UserMessageKey } from '@waypoint/user-messages';
import type { ComputeProviderSummary } from '../../shared/compute-ipc';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import { useToastStore } from '../../stores/toast-store';
import {
  computeEstimateTool,
  computeStatusTool,
  computeSubmitTool,
  computeValidateTool,
  createComputeImportResultTool,
  type ComputeToolContext,
} from '../ai/public/tools/compute';
import { resolveComputeWorkspaceRoot } from './import-result';
import { inspectionPredictionWorkspaceRoot } from '../structure-drawer/public/inspection-prediction';

export interface StructurePredictionPreset {
  provider: string;
  toolId: string;
  model: string;
  settings(sequence: string): Record<string, unknown>;
}

export const STRUCTURE_PREDICTION_PRESETS: readonly StructurePredictionPreset[] = [
  {
    provider: 'boltz',
    toolId: 'boltz-2',
    model: 'Boltz-2',
    settings: (sequence) => ({ sequence }),
  },
  {
    provider: 'nvidia-nim',
    toolId: 'boltz2',
    model: 'Boltz-2',
    settings: (sequence) => ({ polymers: [{ id: 'A', molecule_type: 'protein', sequence }] }),
  },
  {
    provider: 'tamarind',
    toolId: 'esmfold',
    model: 'ESMFold',
    settings: (sequence) => ({ sequence }),
  },
  {
    provider: 'subseq',
    toolId: 'esmfold',
    model: 'ESMFold',
    settings: (sequence) => ({ protein_sequence: sequence }),
  },
];

export const USER_COMPUTE_CAPABILITIES: readonly string[] = [
  'external-compute:discover',
  'external-compute:submit',
];

const POLL_MS = 15_000;
const MAX_WAIT_MS = 2 * 60 * 60 * 1000;
const MAX_PROVIDER_JOB_LABEL = 100;

function providerJobLabel(name: string, model: string, submissionId: string): string {
  const token = submissionId.replace(/[^A-Za-z0-9_-]/g, '').slice(-12) || 'job';
  const suffix = ` · ${token}`;
  const base = `${name} · ${model}`;
  return `${base.slice(0, MAX_PROVIDER_JOB_LABEL - suffix.length)}${suffix}`;
}

export function cleanProteinSequence(raw: string): string {
  return raw.replace(/[^A-Za-z]/g, '').toUpperCase();
}

export interface PredictionOption {
  preset: StructurePredictionPreset;
  provider: ComputeProviderSummary;
  ready: boolean;
}

export function predictionOptions(
  providers: readonly ComputeProviderSummary[]
): PredictionOption[] {
  const options: PredictionOption[] = [];
  for (const preset of STRUCTURE_PREDICTION_PRESETS) {
    const provider = providers.find((p) => p.id === preset.provider);
    if (provider?.hasBinding) options.push({ preset, provider, ready: provider.connected });
  }
  return options;
}

export interface PredictionRequest {
  sequence: string;
  name: string;
  preferredRoot?: string | null;
  inspectionTarget?: { document_id: string; protein_key: string };
}

type Exec = (args: Record<string, unknown>, context: ComputeToolContext) => Promise<unknown>;

export interface PredictionDeps {
  validate: Exec;
  estimate: Exec;
  submit: Exec;
  status: Exec;
  importResult: (folders: WorkspaceFolder[], preferredRoot: string | null) => Exec;
  sleep: (ms: number) => Promise<void>;
  notify: (message: string, type: 'info' | 'success' | 'error') => void;
  newId: () => string;
}

const exec = (tool: { execute?: unknown }): Exec => tool.execute as Exec;

export const PREDICTION_NOTICES = {
  info: 'notice.structure-prediction-submitted-the-result-will-be-imported-when-it-fin',
  success: 'notice.the-predicted-structure-is-saved-in-your-workspace',
  error: 'notice.the-structure-prediction-failed-please-review-the-job-and-try-again',
} as const satisfies Record<'info' | 'success' | 'error', UserMessageKey>;

const defaultDeps: PredictionDeps = {
  validate: (args, context) => exec(computeValidateTool)(args, context),
  estimate: (args, context) => exec(computeEstimateTool)(args, context),
  submit: (args, context) => exec(computeSubmitTool)(args, context),
  status: (args, context) => exec(computeStatusTool)(args, context),
  importResult: (folders, preferredRoot) => (args, context) =>
    exec(createComputeImportResultTool(folders, { preferredRoot }))(args, context),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  notify: (message, type) => {
    useToastStore.getState().addToast(toUserMessage(message, PREDICTION_NOTICES[type]), {
      definition: 'structure-prediction-result',
      variant: type,
    });
  },
  newId: () => crypto.randomUUID(),
};

export type PredictionOutcome =
  | { status: 'submitted'; provider: string; remoteId: string; toolId: string; done: Promise<void> }
  | { status: 'declined' }
  | { status: 'failed'; message: string };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function messageOf(value: Record<string, unknown>, fallback: string): string {
  return typeof value.message === 'string' && value.message ? value.message : fallback;
}

function userContext(
  deps: PredictionDeps,
  workspaceRoot: string | null = null,
  sourcePath: string | null = null,
  sourceName: string | null = null
): ComputeToolContext {
  return {
    grantedCapabilities: [...USER_COMPUTE_CAPABILITIES],
    initiator: 'user',
    toolCallId: `ui-predict-${deps.newId()}`,
    workspaceRoot,
    sourcePath: sourcePath && sourcePath !== workspaceRoot ? sourcePath : null,
    sourceName,
  };
}

export async function runStructurePrediction(
  request: PredictionRequest,
  preset: StructurePredictionPreset,
  folders: WorkspaceFolder[],
  deps: PredictionDeps = defaultDeps
): Promise<PredictionOutcome> {
  const fail = (message: string): PredictionOutcome => {
    deps.notify(message, 'error');
    return { status: 'failed', message };
  };
  const sequence = cleanProteinSequence(request.sequence);
  if (sequence.length === 0) return fail('This protein has no amino-acid sequence to predict.');
  const context = userContext(
    deps,
    resolveComputeWorkspaceRoot(folders, request.preferredRoot ?? null),
    request.preferredRoot ?? null,
    request.name.trim() || null
  );
  const base = {
    provider: preset.provider,
    tool_id: preset.toolId,
    settings: preset.settings(sequence),
  };
  try {
    if (request.inspectionTarget) {
      const owner = await inspectionPredictionWorkspaceRoot(request.inspectionTarget.document_id);
      if (!folders.some((folder) => !folder.pinned && folder.path === owner))
        return fail(
          'Mount the reference protein’s workspace as a writable folder before predicting its structure.'
        );
      context.workspaceRoot = owner;
    }
    const validation = asRecord(await deps.validate(base, context));
    if (validation.ok !== true)
      return fail(messageOf(validation, 'The provider could not check this job.'));
    if (validation.valid === false) {
      const problems = Array.isArray(validation.problems) ? validation.problems.join('; ') : '';
      return fail(`${preset.model} rejected these settings${problems ? `: ${problems}` : '.'}`);
    }
    const estimate = asRecord(await deps.estimate(base, context));
    const estimatedCost =
      estimate.ok === true
        ? {
            amount: typeof estimate.amount === 'number' ? estimate.amount : null,
            unit: typeof estimate.unit === 'string' ? estimate.unit : 'units',
          }
        : undefined;
    const submissionId = deps.newId();
    const submitted = asRecord(
      await deps.submit(
        {
          ...base,
          label: providerJobLabel(request.name, preset.model, submissionId),
          ...(estimatedCost ? { estimated_cost: estimatedCost } : {}),
          idempotency_key: `dnaforge-predict-${submissionId}`,
          ...(request.inspectionTarget ? { inspection_target: request.inspectionTarget } : {}),
        },
        context
      )
    );
    if (submitted.ok !== true) {
      if (submitted.error === 'user_declined') return { status: 'declined' };
      return fail(messageOf(submitted, 'The job could not be submitted.'));
    }
    const job = asRecord(submitted.job);
    const remoteId = typeof job.remote_id === 'string' ? job.remote_id : '';
    if (!remoteId) return fail('The provider accepted the job but returned no job id.');
    deps.notify(
      `Predicting the structure of ${request.name} with ${preset.model}. It opens here when it is done; you can keep working.`,
      'info'
    );
    const done = waitForPredictionAndImport(
      { provider: preset.provider, remoteId, toolId: preset.toolId },
      request,
      preset,
      folders,
      deps
    );
    return {
      status: 'submitted',
      provider: preset.provider,
      remoteId,
      toolId: preset.toolId,
      done,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

const inFlight = new Set<string>();

export async function waitForPredictionAndImport(
  ref: { provider: string; remoteId: string; toolId: string },
  request: PredictionRequest,
  preset: StructurePredictionPreset,
  folders: WorkspaceFolder[],
  deps: PredictionDeps = defaultDeps
): Promise<void> {
  const key = `${ref.provider}:${ref.remoteId}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);
  const context = userContext(deps);
  const args = { provider: ref.provider, remote_id: ref.remoteId, tool_id: ref.toolId };
  try {
    let waited = 0;
    for (;;) {
      const status = asRecord(await deps.status(args, context));
      if (status.ok !== true) {
        deps.notify(
          `Could not check the ${preset.model} prediction for ${request.name}: ${messageOf(status, 'status unavailable')} It is still listed under Compute jobs.`,
          'error'
        );
        return;
      }
      if (status.terminal === true) {
        if (status.state !== 'completed') {
          deps.notify(
            `The ${preset.model} prediction for ${request.name} ended as ${String(status.state)}.`,
            'error'
          );
          return;
        }
        break;
      }
      if (waited >= MAX_WAIT_MS) {
        deps.notify(
          `The ${preset.model} prediction for ${request.name} is still running. Import it from Compute jobs when it finishes.`,
          'info'
        );
        return;
      }
      await deps.sleep(POLL_MS);
      waited += POLL_MS;
    }
    const imported = asRecord(
      await deps.importResult(folders, request.preferredRoot ?? null)(args, context)
    );
    if (imported.ok !== true) {
      deps.notify(messageOf(imported, 'The predicted structure could not be imported.'), 'error');
      return;
    }
    deps.notify(
      `The predicted structure of ${request.name} is saved in your workspace and open in the viewer.`,
      'success'
    );
    reportPredictionLibraryWarnings(imported, deps);
  } catch (error) {
    deps.notify(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    inFlight.delete(key);
  }
}

export async function importCompletedJob(
  job: {
    provider: string;
    remoteId: string | null;
    toolId: string;
    workspaceRoot?: string | null;
    label?: string | null;
  },
  folders: WorkspaceFolder[],
  deps: PredictionDeps = defaultDeps
): Promise<boolean> {
  if (!job.remoteId) return false;
  try {
    const imported = asRecord(
      await deps.importResult(folders, job.workspaceRoot ?? null)(
        { provider: job.provider, remote_id: job.remoteId, tool_id: job.toolId },
        userContext(deps)
      )
    );
    if (imported.ok !== true) {
      deps.notify(messageOf(imported, 'The result could not be imported.'), 'error');
      return false;
    }
    deps.notify(`${job.label ?? job.toolId} is saved in your workspace.`, 'success');
    reportPredictionLibraryWarnings(imported, deps);
    return true;
  } catch (error) {
    deps.notify(error instanceof Error ? error.message : String(error), 'error');
    return false;
  }
}

function reportPredictionLibraryWarnings(imported: Record<string, unknown>, deps: PredictionDeps) {
  const warnings = imported.prediction_library_warnings;
  if (Array.isArray(warnings) && warnings.length)
    deps.notify(
      `Result files were saved, but some could not be registered for protein reuse: ${warnings.join('; ')}`,
      'error'
    );
}
