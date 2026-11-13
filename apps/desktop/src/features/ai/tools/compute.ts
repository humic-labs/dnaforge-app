import { userMessage, userMessageWithValues, userMessageValue, userEntityLabel, userToolLabel } from '@waypoint/user-messages';
import { resultTool, toolSuccess, toolFailure } from '../../agent-bridge/public/tool-result';
import { z } from 'zod';

export * from './compute-output-schemas';

import {
  ApiResponseParseError,
  type EstimateResponse,
  type JobRefModel,
  type JobStatusResponse,
  type ListToolsResponse,
  type ResultResponse,
  type SchemaResponse,
  type ValidateResponse,
  cancelJobComputeProviderIdCancelPost,
  estimateCostComputeProviderIdEstimatePost,
  getSchemaComputeProviderIdSchemaPost,
  isApiError,
  jobResultComputeProviderIdResultPost,
  jobStatusComputeProviderIdStatusPost,
  listToolsComputeProviderIdToolsPost,
  submitJobComputeProviderIdSubmitPost,
  validateSettingsComputeProviderIdValidatePost,
} from '@waypoint/api-client';

import { platform } from '../../../platform';
import { freezeComputeRequest } from '../../../shared/compute-request';
import { useConfirmDialogStore } from '../../../components/confirm-dialog-store';
import { describeComputeFailure, type ComputeFailureKind } from '../../../shared/compute-ipc';
import {
  describeCost,
  describeSubmission,
  importComputeResult,
  resolveComputeWorkspaceRoot,
  useComputeConsentStore,
  useComputeJobsStore,
  useComputeStore,
} from '../../compute/public/agent-tools';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { configureSidecarApiClient } from './sidecar-client';
import { withComputeSubmissionAdmission } from './compute-submission-admission';
import {
  prepareInspectionPrediction,
  inspectionPredictionWorkspaceRoot,
} from '../../structure-drawer/public/inspection-prediction';

const providerIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{1,63}$/, 'provider id, e.g. "tamarind"')
  .describe('Provider id from compute.listProviders (e.g. "tamarind").');
const toolIdSchema = z
  .string()
  .min(1)
  .max(128)
  .describe('Tool id from compute.listTools (e.g. "alphafold", "esmfold").');
const settingsSchema = z
  .record(z.string(), z.unknown())
  .describe('Tool settings matching compute.getSchema for this tool.');

interface ToolContext {
  abortSignal?: AbortSignal;
  toolCallId?: string;
  grantedCapabilities?: string[];

  initiator?: 'agent' | 'user';

  workspaceRoot?: string | null;
  sourcePath?: string | null;
  sourceName?: string | null;
}

export type ComputeToolContext = ToolContext;

export interface ComputeToolFailure {
  ok: false;
  status: number | null;

  error: ComputeFailureKind | 'user_declined' | 'sidecar_error' | 'request_not_retained';
  message: string;
  provider: string;

  next: string;

  code: string;
  retriable: boolean;

  stateChanged: boolean | 'unknown';
  partialEffects: readonly (string | Readonly<Record<string, unknown>>)[];
}

function computeFailure(failure: Omit<ComputeToolFailure, 'ok'>): ComputeToolFailure {
  return { ...toolFailure(failure), ...failure, ok: false };
}

const RETRIABLE_KINDS: ReadonlySet<string> = new Set([
  'sidecar_error',
  'provider_unavailable',
  'rate_limited',
]);

function data200<T>(response: { status: number; data: unknown }): T {
  if (response.status !== 200) {
    throw new Error(`unexpected sidecar status ${response.status}`);
  }
  return response.data as T;
}

function requestHeaders(context: ToolContext): Record<string, string> {
  return context.toolCallId ? { 'X-DNAForge-Action-Id': context.toolCallId } : {};
}

function granted(context: ToolContext): string[] {
  return context.grantedCapabilities ?? [];
}

function providerDisplayName(providerId: string): string {
  const label = useComputeStore.getState().providers.find((p) => p.id === providerId)?.displayName;
  if (label) return userEntityLabel(label);
  return userMessage(providerId === 'tamarind' ? 'compute.tamarind' : 'compute.provider');
}

function failureFrom(
  error: unknown,
  providerId: string,
  stateChanged: boolean | 'unknown' = false
): ComputeToolFailure {
  const display = providerDisplayName(providerId);
  if (error instanceof ApiResponseParseError) {
    return computeFailure({
      status: error.responseStatus,
      error: 'sidecar_error',
      message: 'sidecar returned non-JSON response',
      provider: providerId,
      next: 'Retry once; if it fails again, tell the user the DNAForge background service misbehaved.',
      code: 'sidecar_error',
      retriable: true,
      stateChanged,
      partialEffects: [],
    });
  }
  if (!isApiError(error)) throw error;
  const detail =
    typeof error.body === 'object' && error.body !== null && 'detail' in error.body
      ? (error.body as { detail: unknown }).detail
      : null;
  const kind =
    detail &&
    typeof detail === 'object' &&
    typeof (detail as { error?: unknown }).error === 'string'
      ? ((detail as { error: string }).error as ComputeFailureKind)
      : ('provider_error' as const);
  const message =
    detail &&
    typeof detail === 'object' &&
    typeof (detail as { message?: unknown }).message === 'string'
      ? (detail as { message: string }).message
      : `HTTP ${error.status}`;
  let next = 'Tell the user what the provider said. Do not retry blindly.';
  if (kind === 'missing_credential') {
    useComputeStore.getState().requestConnect(providerId);
    next = `No ${display} key is connected. A "Connect ${display}" chip is now showing in the composer; ask the user to connect it (or use Settings → Integrations), then continue. Do not ask the user to paste the key into chat.`;
  } else if (kind === 'bad_credential') {
    next = `${display} rejected the stored key. Ask the user to replace it under Settings → Integrations.`;
  } else if (kind === 'budget_exhausted') {
    next = `${display} reports the account's budget is exhausted. Stop submitting; tell the user.`;
  } else if (kind === 'rate_limited' || kind === 'circuit_open') {
    next = 'Wait a minute before retrying. Do not loop.';
  } else if (kind === 'invalid_settings') {
    next = 'Fix the settings using compute.getSchema and compute.validate, then resubmit.';
  } else if (kind === 'capability_denied') {
    next = 'This session is not allowed to use compute providers. Tell the user.';
  }
  return computeFailure({
    status: error.status,
    error: kind,
    message: `${describeComputeFailure(kind, display)} ${message}`.trim(),
    provider: providerId,
    next,
    code: kind,
    retriable: RETRIABLE_KINDS.has(kind),
    stateChanged,
    partialEffects: [],
  });
}

export const computeListProvidersSchema = z.object({}).strict();

export const computeListProvidersTool = resultTool({
  description:
    'List hosted compute providers (e.g. Tamarind Bio) and whether the user has connected each one. ' +
    'Call this first; only providers with connected=true and hasBinding=true can run jobs. Read-only, never prompts.',
  inputSchema: computeListProvidersSchema,
  execute: async () => {
    const providers = await platform().compute.listProviders();
    useComputeStore.setState({ providers });
    return toolSuccess({
      providers: providers.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        connected: p.connected,
        hasBinding: p.hasBinding,
        catalog: p.catalog,
        cost: p.cost,
        docsUrl: p.docsUrl,
      })),
      next: providers.some((p) => p.connected && p.hasBinding)
        ? 'Use compute.listTools on a connected provider.'
        : 'No provider is connected. Ask the user to connect one (Settings → Integrations); a connect chip appears when you call a compute tool.',
    });
  },
});

export const computeListToolsSchema = z
  .object({
    provider: providerIdSchema,
    search: z
      .string()
      .max(200)
      .optional()
      .describe(
        'Optional filter on tool ids, names, and task words, e.g. "fold", "binder", "dock". Leave it out to see every tool, and when the user named a specific model.'
      ),
    tags: z
      .array(z.string().min(1).max(64))
      .max(20)
      .optional()
      .describe('Modality/function tags to filter by.'),
  })
  .strict();

export const computeListToolsTool = resultTool({
  description:
    'List the tools/models a connected compute provider offers (structure prediction, design, docking, ...). ' +
    'Discover dynamically; do not assume tool ids. Read-only, never prompts.',
  inputSchema: computeListToolsSchema,
  execute: async (args: z.infer<typeof computeListToolsSchema>, context: ToolContext) => {
    await configureSidecarApiClient('compute.listTools');
    try {
      const response = await listToolsComputeProviderIdToolsPost(
        args.provider,
        {
          granted_capabilities: granted(context),
          search: args.search ?? null,
          tags: args.tags ?? [],
        },
        { headers: requestHeaders(context), signal: context.abortSignal }
      );
      const data = data200<ListToolsResponse>(response);
      return toolSuccess({ provider: args.provider, tools: data.tools });
    } catch (error) {
      return failureFrom(error, args.provider);
    }
  },
});

export const computeGetSchemaSchema = z
  .object({ provider: providerIdSchema, tool_id: toolIdSchema })
  .strict();

export const computeGetSchemaTool = resultTool({
  description:
    "Get a compute tool's settings schema before building a job. Read-only, never prompts.",
  inputSchema: computeGetSchemaSchema,
  execute: async (args: z.infer<typeof computeGetSchemaSchema>, context: ToolContext) => {
    await configureSidecarApiClient('compute.getSchema');
    try {
      const response = await getSchemaComputeProviderIdSchemaPost(
        args.provider,
        { granted_capabilities: granted(context), tool_id: args.tool_id },
        { headers: requestHeaders(context), signal: context.abortSignal }
      );
      const data = data200<SchemaResponse>(response);
      return toolSuccess({ provider: args.provider, tool_id: args.tool_id, schema: data.schema });
    } catch (error) {
      return failureFrom(error, args.provider);
    }
  },
});

export const computeValidateSchema = z
  .object({ provider: providerIdSchema, tool_id: toolIdSchema, settings: settingsSchema })
  .strict();

export const computeValidateTool = resultTool({
  description:
    'Validate job settings with the provider before spending anything. Always call before compute.submit. Read-only, never prompts.',
  inputSchema: computeValidateSchema,
  execute: async (args: z.infer<typeof computeValidateSchema>, context: ToolContext) => {
    await configureSidecarApiClient('compute.validate');
    try {
      const response = await validateSettingsComputeProviderIdValidatePost(
        args.provider,
        {
          granted_capabilities: granted(context),
          tool_id: args.tool_id,
          settings: args.settings as Record<string, never>,
        },
        { headers: requestHeaders(context), signal: context.abortSignal }
      );
      const data = data200<ValidateResponse>(response);
      return toolSuccess({
        provider: data.provider,
        tool_id: data.tool_id,
        valid: data.ok,
        problems: data.problems,
      });
    } catch (error) {
      return failureFrom(error, args.provider);
    }
  },
});

export const computeEstimateSchema = computeValidateSchema;

export const computeEstimateTool = resultTool({
  description:
    'Estimate cost and runtime before submitting. Always call before compute.submit and pass the result as estimated_cost. Read-only, never prompts.',
  inputSchema: computeEstimateSchema,
  execute: async (args: z.infer<typeof computeEstimateSchema>, context: ToolContext) => {
    await configureSidecarApiClient('compute.estimate');
    try {
      const response = await estimateCostComputeProviderIdEstimatePost(
        args.provider,
        {
          granted_capabilities: granted(context),
          tool_id: args.tool_id,
          settings: args.settings as Record<string, never>,
        },
        { headers: requestHeaders(context), signal: context.abortSignal }
      );
      return toolSuccess({ ...data200<EstimateResponse>(response) });
    } catch (error) {
      return failureFrom(error, args.provider);
    }
  },
});

export const computeSubmitSchema = z
  .object({
    provider: providerIdSchema,
    tool_id: toolIdSchema,
    settings: settingsSchema,
    label: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('Human-readable job name shown in the provider UI.'),
    files: z
      .record(z.string().min(1).max(200), z.string().max(4_000_000))
      .optional()
      .describe('Input files by name (UTF-8 text such as PDB/CIF/FASTA).'),
    estimated_cost: z
      .object({ amount: z.number().nullable(), unit: z.string() })
      .optional()
      .describe('The compute.estimate result, shown to the user in the confirmation.'),
    idempotency_key: z.string().min(1).max(128).optional(),
    inspection_target: z
      .object({
        document_id: z.string().min(1).max(500),
        protein_key: z.string().min(1).max(24000).optional(),
      })
      .strict()
      .optional()
      .describe(
        'Return a single-chain prediction to the open mutation inspection for this reference document. Settings must contain exactly its protein sequence. Local destination only; never sent to the provider.'
      ),
  })
  .strict();

const COMPUTE_SUBMIT_DESCRIPTION =
  "Submit a job to a connected compute provider. SPENDS the user's provider budget and sends the settings/files to the provider. " +
  'Call compute.validate and compute.estimate first. The first submit per provider per session asks the user to confirm; ' +
  'if they decline, stop and do not resubmit.';

function inspectionDestinationFailure(provider: string, error: unknown): ComputeToolFailure {
  return computeFailure({
    status: null,
    error: 'sidecar_error',
    provider,
    code: 'inspection_destination_unavailable',
    message: error instanceof Error ? error.message : String(error),
    next: 'Keep the reference protein inspection open and resolve this error before submitting.',
    retriable: true,
    stateChanged: false,
    partialEffects: [],
  });
}

async function executeComputeSubmit(
  args: z.infer<typeof computeSubmitSchema>,
  context: ToolContext
) {
  const submission = freezeComputeRequest(args.provider, args.tool_id, args.settings, args.files);
  args = {
    ...args,
    settings: submission.settings,
    files: submission.files,
    estimated_cost: args.estimated_cost ? { ...args.estimated_cost } : undefined,
    inspection_target: args.inspection_target ? { ...args.inspection_target } : undefined,
  };
  let resultTarget: Awaited<ReturnType<typeof prepareInspectionPrediction>> | null = null;
  if (args.inspection_target) {
    try {
      if (!context.workspaceRoot || Object.keys(args.files ?? {}).length > 0)
        throw new Error(
          'Inspection prediction needs an owning workspace and one sequence in settings, without input-file overrides.'
        );
      if (
        (await inspectionPredictionWorkspaceRoot(args.inspection_target.document_id)) !==
        context.workspaceRoot
      )
        throw new Error(
          'The prediction destination does not match the reference protein’s workspace.'
        );
      resultTarget = await prepareInspectionPrediction(args.inspection_target, args.settings);
    } catch (error) {
      return inspectionDestinationFailure(args.provider, error);
    }
  }
  return withComputeSubmissionAdmission(args.provider, async (admission) => {
    context.abortSignal?.throwIfAborted();
    const display = providerDisplayName(args.provider);
    const cost = args.estimated_cost?.amount ?? null;
    const consent = useComputeConsentStore.getState();
    if (consent.needsConfirmation(args.provider, cost)) {
      const confirmed = await useConfirmDialogStore.getState().confirm({
        title: userMessageWithValues('compute.submitTitle', { provider: userMessageValue(userEntityLabel(display)) }),
        message: userMessageWithValues('compute.submitConsent', { actor: userMessageValue(context.initiator === 'user' ? 'You are about to run' : 'The assistant wants to run'), tool: userMessageValue(userToolLabel(args.tool_id, 'compute.genericTool')), provider: userMessageValue(userEntityLabel(display)), submission: userMessageValue(describeSubmission(args.settings, args.files ?? {})), cost: userMessageValue(describeCost(cost, args.estimated_cost?.unit ?? 'units')) }),
        confirmLabel: userMessage('compute.run'),
        cancelLabel: userMessage('compute.notNow'),
        safeDefault: true,
        signal: context.abortSignal,
      });
      if (!confirmed) {
        return computeFailure({
          status: null,
          error: 'user_declined',
          message: `The user declined to send this job to ${display}.`,
          provider: args.provider,
          next: 'Stop. Do not resubmit or work around the decline. Ask the user how they want to proceed.',
          code: 'user_declined',
          retriable: false,
          stateChanged: false,
          partialEffects: [],
        });
      }
      useComputeConsentStore.getState().recordConfirmation(args.provider);
    }
    admission.phase = 'retaining';
    await configureSidecarApiClient('compute.submit');

    const providerSummary = useComputeStore
      .getState()
      .providers.find((p) => p.id === args.provider);
    let intent;
    try {
      intent = await useComputeJobsStore.getState().recordIntent({
        provider: args.provider,
        toolId: args.tool_id,
        label: args.label ?? null,
        settings: submission.settings,
        files: submission.files,
        idempotencyKey: args.idempotency_key,
        resultTarget,
        costEstimate: cost,
        costEstimateUnit: args.estimated_cost?.unit ?? null,
        workspaceRoot: context.workspaceRoot ?? null,
        sourcePath: context.sourcePath ?? null,
        sourceName: context.sourceName ?? null,
        termsSnapshot: providerSummary
          ? {
              providerDisplayName: providerSummary.displayName,
              termsUrl: providerSummary.termsUrl,
              disclosure: providerSummary.disclosure,
            }
          : null,
      });
    } catch (error) {
      return computeFailure({
        status: null,
        error: 'request_not_retained',
        provider: args.provider,
        code: 'request_not_retained',
        message:
          error instanceof Error ? error.message : 'The prediction request could not be retained.',
        next: 'Resolve the retained job or the desktop registry error before sending another request.',
        retriable: false,
        stateChanged: false,
        partialEffects: [],
      });
    }
    const retained = intent.submissionRequest;
    const intentId = intent.id;
    if (!retained || !intent.idempotencyKey)
      throw new Error('The native registry did not return the retained submission request.');
    admission.phase = 'submitting';
    try {
      const response = await submitJobComputeProviderIdSubmitPost(
        retained.provider,
        {
          granted_capabilities: granted(context),
          action_id: context.toolCallId ?? null,
          tool_id: retained.toolId,
          settings: retained.settings as Record<string, never>,
          label: args.label ?? null,
          idempotency_key: intent.idempotencyKey,
          files: retained.files,
        },
        { headers: requestHeaders(context), signal: context.abortSignal }
      );
      useComputeConsentStore.getState().recordSubmit(args.provider, cost);
      const ref = data200<JobRefModel>(response);
      await useComputeJobsStore.getState().markSubmitted(intentId, ref.remote_id);
      return toolSuccess({
        job: ref,
        job_record_id: intentId,
        next: 'DNAForge polls this job in the background and lists it under Compute jobs. Call compute.status to check, no more than once every 15 seconds; when terminal=true and state is completed, call compute.importResult.',
      });
    } catch (error) {
      let failure: ComputeToolFailure;
      try {
        failure = failureFrom(error, args.provider, 'unknown');
      } catch {
        failure = computeFailure({
          status: null,
          error: 'sidecar_error',
          code: 'sidecar_error',
          message: error instanceof Error ? error.message : 'Submission acknowledgement was lost.',
          provider: args.provider,
          next: '',
          retriable: false,
          stateChanged: 'unknown',
          partialEffects: [],
        });
      }
      const refusedBeforeSubmit = new Set([
        'capability_denied',
        'missing_credential',
        'bad_credential_format',
        'unknown_provider',
        'compute_service_unavailable',
      ]).has(failure.error);
      try {
        const registry = useComputeJobsStore.getState();
        if (refusedBeforeSubmit)
          await registry.markFailed(intentId, `${failure.error}: ${failure.message}`);
        else await registry.markSubmissionUnknown(intentId, `${failure.error}: ${failure.message}`);
      } catch {}
      const retainedFailure: ComputeToolFailure & { job_record_id: string } = {
        ...failure,
        job_record_id: intentId,
        retriable: false,
        stateChanged: refusedBeforeSubmit ? false : 'unknown',
        next: refusedBeforeSubmit
          ? failure.next
          : 'Submission is unconfirmed. Check this retained job and the provider account before submitting again. Do not create a new idempotency key or retry the POST automatically.',
        partialEffects: [{ job_record_id: intentId, request_sha256: intent.requestHash }],
      };
      return retainedFailure;
    }
  });
}

export const computeSubmitTool = resultTool({
  description: COMPUTE_SUBMIT_DESCRIPTION,
  inputSchema: computeSubmitSchema,
  execute: executeComputeSubmit,
});

export function createComputeSubmitTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description: COMPUTE_SUBMIT_DESCRIPTION,
    inputSchema: computeSubmitSchema,
    execute: async (args: z.infer<typeof computeSubmitSchema>, context: ToolContext) => {
      let workspaceRoot = resolveComputeWorkspaceRoot(folders);
      if (args.inspection_target) {
        try {
          workspaceRoot = await inspectionPredictionWorkspaceRoot(
            args.inspection_target.document_id
          );
          if (!folders.some((folder) => !folder.pinned && folder.path === workspaceRoot))
            throw new Error(
              'Mount the reference protein’s workspace as a writable folder before submitting its prediction.'
            );
        } catch (error) {
          return inspectionDestinationFailure(args.provider, error);
        }
      }
      return executeComputeSubmit(args, { ...context, workspaceRoot });
    },
  });
}

export const computeJobRefSchema = z
  .object({
    provider: providerIdSchema,
    remote_id: z.string().min(1).max(256).describe('remote_id returned by compute.submit.'),
    tool_id: toolIdSchema,
  })
  .strict();

export const computeStatusTool = resultTool({
  description:
    "Check a submitted job's status. Read-only, never prompts. Poll no more than once every 15 seconds.",
  inputSchema: computeJobRefSchema,
  execute: async (args: z.infer<typeof computeJobRefSchema>, context: ToolContext) => {
    await configureSidecarApiClient('compute.status');
    try {
      const response = await jobStatusComputeProviderIdStatusPost(
        args.provider,
        {
          granted_capabilities: granted(context),
          remote_id: args.remote_id,
          tool_id: args.tool_id,
        },
        { headers: requestHeaders(context), signal: context.abortSignal }
      );
      return toolSuccess({ ...data200<JobStatusResponse>(response) });
    } catch (error) {
      return failureFrom(error, args.provider);
    }
  },
});

export const computeImportResultSchema = computeJobRefSchema;

export function createComputeImportResultTool(
  folders: WorkspaceFolder[],
  options: { preferredRoot?: string | null } = {}
) {
  return resultTool({
    description:
      "Fetch a completed job's result from the provider and land it in the workspace: each predicted structure becomes a molecular view file beside the job's source sequence (or at the project top level), registered with provenance, and the first structure opens in the 3D viewer. Other output files stay with the job record, not the project. Read-only on the provider side, never prompts.",
    inputSchema: computeImportResultSchema,
    execute: async (args: z.infer<typeof computeImportResultSchema>, context: ToolContext) => {
      await configureSidecarApiClient('compute.importResult');
      let bundle: ResultResponse;
      try {
        const response = await jobResultComputeProviderIdResultPost(
          args.provider,
          {
            granted_capabilities: granted(context),
            remote_id: args.remote_id,
            tool_id: args.tool_id,
          },
          { headers: requestHeaders(context), signal: context.abortSignal }
        );
        bundle = data200<ResultResponse>(response);
      } catch (error) {
        return failureFrom(error, args.provider, 'unknown');
      }
      let record = null;
      try {
        record = await platform().compute.findJob(args.provider, args.remote_id);
      } catch (error) {
        return inspectionDestinationFailure(args.provider, error);
      }
      if (
        record &&
        (record.toolId !== args.tool_id || ['failed', 'canceled', 'intent'].includes(record.state))
      )
        return inspectionDestinationFailure(
          args.provider,
          new Error(
            'This prediction job is failed, canceled, not submitted, or belongs to another tool.'
          )
        );
      let imported;
      try {
        imported = await importComputeResult(
          {
            provider: args.provider,
            remoteId: args.remote_id,
            toolId: args.tool_id,
            outputKind: bundle.output_kind,
            files: bundle.files,
            metrics: bundle.metrics as Record<string, unknown>,
            provenance: bundle.provenance,
            settingsHash: record?.settingsHash ?? null,
            label: record?.label ?? null,
            ...(record ? { job: record } : {}),
            ...(record?.resultTarget
              ? {
                  inspectionDestination: {
                    target: record.resultTarget,
                    jobRecordId: record.id,
                    recordedAt: record.createdAt,
                  },
                }
              : {}),
          },
          folders,
          { preferredRoot: record?.workspaceRoot ?? options.preferredRoot ?? null }
        );
      } catch (error) {
        return {
          ...inspectionDestinationFailure(args.provider, error),
          code: 'compute_import_failed',
          stateChanged: 'unknown' as const,
          next: 'The import did not finish. Existing result files are retained; correct the reported problem before retrying.',
          partialEffects: ['Some result files may have been written before the import stopped.'],
        };
      }
      if (!imported.ok) {
        return computeFailure({
          status: null,
          error: 'sidecar_error' as const,
          message: imported.message,
          provider: args.provider,
          next:
            imported.error === 'no_workspace'
              ? 'Ask the user to open a workspace folder, then call compute.importResult again.'
              : 'Tell the user the provider returned nothing to import.',
          code: imported.error === 'no_workspace' ? 'no_workspace' : 'nothing_to_import',

          retriable: imported.error === 'no_workspace',

          stateChanged: false,
          partialEffects: [],
        });
      }
      if (record) {
        try {
          await useComputeJobsStore
            .getState()
            .markImported(record.id, imported.writtenPaths, imported.importDetails);
        } catch {}
      }
      return toolSuccess({
        ref: bundle.ref,
        output_kind: bundle.output_kind,
        written_paths: imported.writtenPaths,
        opened: imported.opened,
        ...(imported.inspectionAttached ? { inspection_attached: true } : {}),
        url_only: imported.urlOnly,
        metrics: imported.metrics,
        provenance: imported.provenance,
        prediction_result_ids: imported.predictionResultIds,
        catalog_observation_ids: imported.catalogObservationIds,
        prediction_library_warnings: imported.predictionLibraryWarnings,
        next: imported.inspectionAttached
          ? 'The predicted coordinates are attached to their original mutation inspection. Inspect the native residue mapping and save the analysis view; prediction is not experimental validation.'
          : imported.opened.length > 0
            ? 'The structure is open in the viewer. Report the provider metrics as given; do not turn them into a yes/no verdict.'
            : 'Predicted structures are molecular view files in the project. Summarize what was written.',
      });
    },
  });
}

export const computeCancelTool = resultTool({
  description:
    'Stop a job you submitted that has not finished yet. Spends nothing, and the provider may still bill work already done. ' +
    'Some providers cannot cancel at all and say so; report that rather than claiming the job stopped. Never prompts.',
  inputSchema: computeJobRefSchema,
  execute: async (args: z.infer<typeof computeJobRefSchema>, context: ToolContext) =>
    cancelComputeJob(args, context),
});

export async function cancelComputeJob(
  args: z.infer<typeof computeJobRefSchema>,
  context: ToolContext
) {
  await configureSidecarApiClient('compute.cancel');
  try {
    const response = await cancelJobComputeProviderIdCancelPost(
      args.provider,
      { granted_capabilities: granted(context), remote_id: args.remote_id, tool_id: args.tool_id },
      { headers: requestHeaders(context), signal: context.abortSignal }
    );
    return toolSuccess({ ...data200<JobStatusResponse>(response) });
  } catch (error) {
    return failureFrom(error, args.provider, 'unknown');
  }
}
