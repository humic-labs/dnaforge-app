import {
  resultTool,
  toolSuccess,
  type ToolStateChange,
  type ToolFailure,
} from '../../agent-bridge/public/tool-result';
import { z } from 'zod';
import { computeChecksum } from '@waypoint/sequence-utils';
import { isSequencePackageFileKind } from '../../../db/sequence-package';
import { getCurrentCatalogFileForEntity } from '../../../db/workspace-catalog';
import { buildAcceptedAssemblyLineage } from '../../assembly/public/accepted-lineage';
import {
  FinalizationProjectError,
  getStoredFinalizationPreview,
  prepareFinalizationCandidate,
  previewFinalizeDesignAssembly,
} from '../../assembly/public/accepted-finalization-preview';
import { finalizeAcceptedAssemblyWorkflow } from '../../assembly/public/accepted-finalization-workflow';
import { reopenAcceptedAssemblyWorkflow } from '../../assembly/public/accepted-reopen-workflow';
import {
  resolveAcceptedAssemblyRecord,
  type AcceptedRecordSelector,
  type ResolvedAcceptedAssemblyRecord,
} from '../../assembly/public/accepted-record-reader';
import { useDesignStore } from '../../design/public/store';
import { useSequenceStore } from '../../sequence/public/store';
import { NativeArtifactPublicationPendingError } from '../../../services/publish-native-artifact';

const acceptedRecordSelectorShape = {
  constructId: z
    .string()
    .min(1)
    .optional()
    .describe('Stable construct id returned by finalization or lineage readback.'),
  acceptedAssemblyVersionId: z
    .string()
    .min(1)
    .optional()
    .describe('Exact immutable accepted-assembly version id.'),
};

export const previewFinalizeDesignAssemblySchema = z
  .object({
    designId: z.string().min(1).describe('Design id returned by get_design.'),
    expectedDesignVersion: z
      .number()
      .int()
      .min(0)
      .describe('Exact design version last read from get_design.'),
    overwrite: z
      .boolean()
      .optional()
      .describe('Allow replacing the exact existing plasmid package at the target path.'),
    replaceProduct: z
      .boolean()
      .optional()
      .describe(
        'Required when the destination plasmid file no longer matches the last accepted construction. Replaces that edited DNA with the new assembly product.'
      ),
  })
  .strict();

export const finalizeDesignAssemblySchema = z
  .object({
    designId: z.string().min(1).describe('The same design id used for preview.'),
    expectedDesignVersion: z
      .number()
      .int()
      .min(0)
      .describe('The same design version used for preview.'),
    previewFingerprint: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .describe('Unexpired fingerprint returned by preview_finalize_design_assembly.'),
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'Stable key for this exact finalization intent. Exact retries do not duplicate work.'
      ),
  })
  .strict();

export const reopenAcceptedAssemblySchema = z
  .object({
    acceptedAssemblyVersionId: z
      .string()
      .min(1)
      .describe('Exact immutable accepted-assembly version to reopen.'),
    constructId: acceptedRecordSelectorShape.constructId,
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .describe('Stable key for this exact reopen intent. Exact retries return the same draft.'),
  })
  .strict();

export const getConstructLineageSchema = z
  .object(acceptedRecordSelectorShape)
  .strict()
  .refine((value) => value.constructId || value.acceptedAssemblyVersionId, {
    message: 'Provide constructId or acceptedAssemblyVersionId.',
  });

export const getAcceptedAssemblySchema = z
  .object({
    acceptedAssemblyVersionId: z
      .string()
      .min(1)
      .describe('Exact immutable accepted-assembly version id to inspect.'),
    constructId: acceptedRecordSelectorShape.constructId,
  })
  .strict();

type AcceptedRecordResolver = (
  selector: AcceptedRecordSelector
) => Promise<ResolvedAcceptedAssemblyRecord>;

type FinalizationResult = Awaited<ReturnType<typeof finalizeAcceptedAssemblyWorkflow>>;
const completedFinalizations = new Map<
  string,
  { previewFingerprint: string; result: FinalizationResult }
>();
const inFlightFinalizations = new Map<
  string,
  { previewFingerprint: string; promise: Promise<FinalizationResult> }
>();

export function createPreviewFinalizeDesignAssemblyTool() {
  return resultTool({
    description:
      'Preview assembly finalization without writing or mutating anything. Returns blockers, ' +
      'warnings, exact source/checksum inputs, stable output identity, and a short-lived fingerprint. ' +
      'When the user requests saved exact products or accepted assemblies, use the returned ' +
      'fingerprint and exact version with finalize_design_assembly to save that inspected snapshot.',
    inputSchema: previewFinalizeDesignAssemblySchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof previewFinalizeDesignAssemblySchema>) => {
      try {
        return toolSuccess({
          canFinalize: true,
          ...stripPrivateSequenceLocators(await previewFinalizeDesignAssembly(input)),
        });
      } catch (error) {
        return toolSuccess({
          canFinalize: false,
          designId: input.designId,
          expectedDesignVersion: input.expectedDesignVersion,
          blockers: [
            {
              code: error instanceof FinalizationProjectError ? error.code : 'preview_rejected',
              message: error instanceof Error ? error.message : String(error),
            },
          ],
          warnings: [],
        });
      }
    },
  });
}

export function createFinalizeDesignAssemblyTool(
  resolveRecord: AcceptedRecordResolver = resolveAcceptedAssemblyRecord,
  getCurrentBinding: (
    entityId: string
  ) => Promise<{ path: string; file_kind: string } | null> = getCurrentCatalogFileForEntity
) {
  return resultTool({
    description:
      'Finalize exactly the previously previewed assembly into a durable plasmid package. ' +
      'Requires an unexpired preview fingerprint, the exact design version, and an idempotency ' +
      'key. Does not open a tab; call open_tab with type sequence and the returned constructId.',
    inputSchema: finalizeDesignAssemblySchema as z.ZodTypeAny,
    execute: async (
      input: z.infer<typeof finalizeDesignAssemblySchema>,
      context?: { toolCallId?: string; abortSignal?: AbortSignal }
    ) => {
      const mapKey = `${input.designId}:${input.idempotencyKey}`;
      const completed = completedFinalizations.get(mapKey);
      if (completed) {
        if (completed.previewFingerprint !== input.previewFingerprint) {
          return idempotencyConflict(input);
        }
        return projectFinalizationResult(completed.result, true);
      }
      const inFlight = inFlightFinalizations.get(mapKey);
      if (inFlight) {
        if (inFlight.previewFingerprint !== input.previewFingerprint) {
          return idempotencyConflict(input);
        }
        return projectFinalizationResult(await inFlight.promise, true);
      }





      try {
        const existing = await resolveDurableFinalization(
          input.designId,
          resolveRecord,
          getCurrentBinding
        );
        const operation = existing.accepted.agentOperation;
        if (operation?.idempotencyKey === input.idempotencyKey) {
          if (operation.previewFingerprint !== input.previewFingerprint) {
            return idempotencyConflict(input);
          }
          return hasFinalizationCompletionMarker(existing)
            ? reconciledFinalizationResult(existing)
            : recoveryRequiredFinalization(input, existing);
        }
      } catch (error) {
        if (!isAcceptedRecordAbsent(error)) return rejectedFinalization(input, error);
      }

      let stored;
      try {
        stored = getStoredFinalizationPreview(input.previewFingerprint);
      } catch (error) {
        return rejectedFinalization(input, error);
      }
      if (
        stored.preview.designId !== input.designId ||
        stored.preview.expectedDesignVersion !== input.expectedDesignVersion
      ) {
        return rejectedFinalization(
          input,
          new Error('Preview fingerprint belongs to a different design or design version.')
        );
      }
      if (context?.abortSignal?.aborted) {
        return rejectedFinalization(input, new Error('Finalization was canceled before commit.'));
      }



      try {
        const existing = await resolveRecord({ locator: stored.preview.productPath });
        if (
          existing.accepted.agentOperation?.idempotencyKey === input.idempotencyKey &&
          existing.accepted.agentOperation.previewFingerprint === input.previewFingerprint
        ) {
          return hasFinalizationCompletionMarker(existing)
            ? reconciledFinalizationResult(existing)
            : recoveryRequiredFinalization(input, existing);
        }
      } catch (error) {
        if (!isAcceptedRecordAbsent(error)) return rejectedFinalization(input, error);
      }

      let mutationStarted = false;
      const operation = (async () => {
        const candidate = await prepareFinalizationCandidate({
          designId: input.designId,
          expectedDesignVersion: input.expectedDesignVersion,
          targetProductPath: stored.preview.targetProductPath,
          overwrite: stored.overwrite,
          replaceProduct: stored.replaceProduct,
          constructId: stored.preview.constructId,
          acceptedBy: `agent:${context?.toolCallId ?? 'mcp'}`,
          agentOperation: {
            idempotencyKey: input.idempotencyKey,
            previewFingerprint: input.previewFingerprint,
          },
        });
        if (candidate.signature !== stored.signature) {
          throw new Error(
            'Design, source bytes, or output target changed after preview. Preview finalization again.'
          );
        }
        if (context?.abortSignal?.aborted) {
          throw new Error('Finalization was canceled before commit.');
        }
        mutationStarted = true;
        return finalizeAcceptedAssemblyWorkflow({
          candidate,
          actor: `agent:${context?.toolCallId ?? 'mcp'}`,
          notify: false,
          abortSignal: context?.abortSignal,
          agentOperation: {
            idempotencyKey: input.idempotencyKey,
            previewFingerprint: input.previewFingerprint,
          },
        });
      })();
      inFlightFinalizations.set(mapKey, {
        previewFingerprint: input.previewFingerprint,
        promise: operation,
      });
      try {
        const result = await operation;
        completedFinalizations.set(mapKey, {
          previewFingerprint: input.previewFingerprint,
          result,
        });
        return projectFinalizationResult(result, false);
      } catch (error) {
        if (error instanceof NativeArtifactPublicationPendingError)
          return {
            ok: false,
            status: 'recovery_required',
            code: 'FINALIZATION_PUBLICATION_PENDING',
            retriable: false,
            stateChanged: true,
            designId: input.designId,
            idempotencyKey: input.idempotencyKey,
            accepted: error.accepted,
            partialEffects: [{ constructId: error.accepted.resourceId }],
            error: error.message,
          };
        try {
          const partial = await resolveRecord({ locator: stored.preview.productPath });
          if (
            partial.accepted.agentOperation?.idempotencyKey === input.idempotencyKey &&
            partial.accepted.agentOperation.previewFingerprint === input.previewFingerprint
          ) {
            return hasFinalizationCompletionMarker(partial)
              ? reconciledFinalizationResult(partial)
              : recoveryRequiredFinalization(input, partial, error);
          }
        } catch (reconcileError) {
          if (!isAcceptedRecordAbsent(reconcileError)) {
            return rejectedFinalization(input, reconcileError, mutationStarted ? 'unknown' : false);
          }
        }
        return rejectedFinalization(input, error, mutationStarted ? 'unknown' : false);
      } finally {
        if (inFlightFinalizations.get(mapKey)?.promise === operation) {
          inFlightFinalizations.delete(mapKey);
        }
      }
    },
  });
}

async function resolveDurableFinalization(
  designId: string,
  resolveRecord: AcceptedRecordResolver,
  getCurrentBinding: (entityId: string) => Promise<{ path: string; file_kind: string } | null>
): Promise<ResolvedAcceptedAssemblyRecord> {
  const constructId = useDesignStore.getState().designs[designId]?.constructId;
  if (constructId) {
    try {
      return await resolveRecord({ constructId });
    } catch (constructError) {
      const binding = await getCurrentBinding(constructId);
      if (isSequencePackageFileKind(binding?.file_kind)) {
        return resolveRecord({ locator: binding.path });
      }
      throw constructError;
    }
  }
  const binding = await getCurrentBinding(designId);
  if (isSequencePackageFileKind(binding?.file_kind)) {
    return resolveRecord({ locator: binding.path });
  }
  throw new Error(`Construct is not file-backed for design ${designId}`);
}

export function createReopenAcceptedAssemblyTool(
  resolveRecord: AcceptedRecordResolver = resolveAcceptedAssemblyRecord
) {
  return resultTool({
    description:
      'Reopen one immutable accepted assembly as a new durable file-backed editable draft. ' +
      'Exact retries return the same draft. The accepted record and product are unchanged, and ' +
      'the tool does not open a tab; call open_tab separately with the returned designId.',
    inputSchema: reopenAcceptedAssemblySchema as z.ZodTypeAny,
    execute: async (
      input: z.infer<typeof reopenAcceptedAssemblySchema>,
      context?: { toolCallId?: string; abortSignal?: AbortSignal }
    ) => {
      if (context?.abortSignal?.aborted) {
        return rejectedReopen(input, new Error('Reopen was canceled before creating a draft.'));
      }
      try {
        return toolSuccess({
          ...(await reopenAcceptedAssemblyWorkflow({
            selector: {
              acceptedAssemblyVersionId: input.acceptedAssemblyVersionId,
              constructId: input.constructId,
            },
            idempotencyKey: input.idempotencyKey,
            actor: `agent:${context?.toolCallId ?? 'mcp'}`,
            resolveRecord,
            abortSignal: context?.abortSignal,
          })),
        });
      } catch (error) {
        return rejectedReopen(input, error, 'unknown');
      }
    },
  });
}

function projectFinalizationResult(result: FinalizationResult, idempotentReplay: boolean) {
  return toolSuccess({
    status: 'completed',
    idempotentReplay,
    constructId: result.constructId,
    acceptedAssemblyVersionId: result.acceptedVersion.id,
    canonicalDraftChecksum: result.acceptedVersion.canonicalDraftChecksum,
    productSequenceVersionId: result.productSequenceChecksum,
    productSequenceChecksum: result.productSequenceChecksum,
    productGenBankChecksum: result.productGenBankChecksum,
    historyState: result.historyState,
    gitCommitSha: result.gitCommitSha,
    openTabRequired: true,
    ...(result.acceptedRevision
      ? {
          acceptedRevision: result.acceptedRevision,
          acceptedAssemblyResourceId: result.acceptedAssemblyResourceId,
        }
      : {}),
  });
}

function reconciledFinalizationResult(existing: ResolvedAcceptedAssemblyRecord) {
  const marker = finalizationCompletionMarker(existing);
  return toolSuccess({
    status: 'completed',
    idempotentReplay: true,
    constructId: existing.constructId,
    acceptedAssemblyVersionId: existing.acceptedAssemblyVersionId,
    canonicalDraftChecksum: existing.accepted.construction.canonicalDraftChecksum,
    productSequenceVersionId: existing.accepted.artifacts.productSequenceChecksum,
    productSequenceChecksum: existing.accepted.artifacts.productSequenceChecksum,
    productGenBankChecksum: existing.accepted.artifacts.productGenBankChecksum ?? null,
    historyState:
      marker?.payload?.historyState === 'committed' || marker?.payload?.historyState === 'not-git'
        ? marker.payload.historyState
        : 'reconciled-from-package',
    gitCommitSha:
      typeof marker?.payload?.gitCommitSha === 'string' ? marker.payload.gitCommitSha : null,
    openTabRequired: true,
  });
}

function acceptedFailure<T extends ToolFailure & Record<string, unknown>>(failure: T) {
  return { ...failure, details: failure };
}

function rejectedFinalization(
  input: z.infer<typeof finalizeDesignAssemblySchema>,
  error: unknown,
  stateChanged: ToolStateChange = false
) {
  return acceptedFailure({
    ok: false as const,
    status: 'rejected',
    code: 'FINALIZATION_REJECTED',
    retriable: false,
    stateChanged,
    partialEffects: [],
    designId: input.designId,
    expectedDesignVersion: input.expectedDesignVersion,
    previewFingerprint: input.previewFingerprint,
    idempotencyKey: input.idempotencyKey,
    error: error instanceof Error ? error.message : String(error),
  });
}

function recoveryRequiredFinalization(
  input: z.infer<typeof finalizeDesignAssemblySchema>,
  existing: ResolvedAcceptedAssemblyRecord,
  cause?: unknown
) {
  return acceptedFailure({
    ok: false as const,
    status: 'recovery_required',
    code: 'FINALIZATION_RECOVERY_REQUIRED',
    retriable: false,
    stateChanged: true,
    designId: input.designId,
    idempotencyKey: input.idempotencyKey,
    acceptedAssemblyVersionId: existing.acceptedAssemblyVersionId,
    constructId: existing.constructId,
    partialEffects: [{ constructId: existing.constructId }],
    error:
      'The package was written but its catalog/Git completion marker is missing. ' +
      'Inspect the durable construct package and repair or remove the partial finalization before retrying.' +
      (cause ? ` Cause: ${cause instanceof Error ? cause.message : String(cause)}` : ''),
  });
}

function rejectedReopen(
  input: z.infer<typeof reopenAcceptedAssemblySchema>,
  error: unknown,
  stateChanged: ToolStateChange = false
) {
  return acceptedFailure({
    ok: false as const,
    status: 'rejected',
    code: 'REOPEN_REJECTED',
    retriable: false,
    stateChanged,
    partialEffects: [],
    acceptedAssemblyVersionId: input.acceptedAssemblyVersionId,
    idempotencyKey: input.idempotencyKey,
    error: error instanceof Error ? error.message : String(error),
  });
}

function finalizationCompletionMarker(existing: ResolvedAcceptedAssemblyRecord) {
  return existing.catalogEvents.find(
    (event) =>
      event.eventType === 'assembly_finalized' &&
      event.payload?.acceptedAssemblyVersionId === existing.acceptedAssemblyVersionId
  );
}

function hasFinalizationCompletionMarker(existing: ResolvedAcceptedAssemblyRecord): boolean {
  return finalizationCompletionMarker(existing) !== undefined;
}

function isAcceptedRecordAbsent(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not file-backed|not a finalized plasmid package|record does not exist|could not resolve an accepted assembly|no accepted assembly record/i.test(
    message
  );
}

function idempotencyConflict(input: z.infer<typeof finalizeDesignAssemblySchema>) {
  return rejectedFinalization(
    input,
    new Error('This idempotency key was already used for a different finalization preview.')
  );
}

export function clearAssemblyFinalizationIdempotencyForTests(): void {
  completedFinalizations.clear();
  inFlightFinalizations.clear();
}

export function createGetConstructLineageTool(
  resolveRecord: AcceptedRecordResolver = resolveAcceptedAssemblyRecord
) {
  return resultTool({
    description:
      'Read the typed construct lineage graph for a finalized plasmid. Returns distinct draft, ' +
      'accepted-assembly, exact source-version, product-version, artifact, and catalog-event ' +
      'records. Legacy sources are labeled explicitly; stable identities are never invented.',
    inputSchema: getConstructLineageSchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof getConstructLineageSchema>) => {
      try {
        const record = await resolveRecord(input);
        const currentSourceChecksums = await currentSourceChecksumsFor(record.acceptedRecords);
        return toolSuccess({
          exists: true,
          constructId: record.constructId,
          acceptedAssemblyVersionId: record.acceptedAssemblyVersionId,
          integrity: record.integrity,
          lineage: stripPrivateSequenceLocators(
            buildAcceptedAssemblyLineage(record.acceptedRecords, {
              constructId: record.constructId,
              packageId: record.packageId,
              packageRoot: record.packageRoot,
              catalogEvents: record.catalogEvents,
              currentSourceChecksums,
            })
          ),
        });
      } catch (error) {
        return {
          ok: false as const,
          code: 'CONSTRUCT_LINEAGE_UNAVAILABLE',
          retriable: false,
          stateChanged: false,
          partialEffects: [],
          exists: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

async function currentSourceChecksumsFor(
  acceptedRecords: readonly ResolvedAcceptedAssemblyRecord['accepted'][]
): Promise<Record<string, string>> {
  const sequences = useSequenceStore.getState().sequences;
  const checksums: Record<string, string> = {};
  for (const accepted of acceptedRecords) {
    for (const source of accepted.projectionInput.sourceProvenance) {
      const locator = source.sourceLocator ?? source.sourceSequenceId;
      const loaded = sequences[locator] ?? sequences[source.sourceSequenceId];
      if (!loaded || checksums[locator]) continue;
      checksums[locator] = await computeChecksum(loaded.sequence);
    }
  }
  return checksums;
}

export function createGetAcceptedAssemblyTool(
  resolveRecord: AcceptedRecordResolver = resolveAcceptedAssemblyRecord
) {
  return resultTool({
    description:
      'Read one immutable accepted assembly version and its validation, exact source snapshots, ' +
      'primers, product, and artifact checksums. This is inspection only: it never creates or ' +
      'hydrates an editable design.',
    inputSchema: getAcceptedAssemblySchema as z.ZodTypeAny,
    execute: async (input: z.infer<typeof getAcceptedAssemblySchema>) => {
      try {
        const record = await resolveRecord(input);
        if (record.recordIsCurrent && record.integrity.productGenBank !== 'verified') {
          throw new Error(
            `Accepted assembly product integrity is ${record.integrity.productGenBank}; inspection is blocked until the immutable package is repaired.`
          );
        }
        return toolSuccess({
          exists: true,
          immutable: true,
          constructId: record.constructId,
          packageId: record.packageId,
          acceptedAssemblyVersionId: record.acceptedAssemblyVersionId,
          integrity: record.integrity,
          acceptedAssembly: stripPrivateSequenceLocators(record.accepted),
        });
      } catch (error) {
        return {
          ok: false as const,
          code: 'ACCEPTED_ASSEMBLY_UNAVAILABLE',
          retriable: false,
          stateChanged: false,
          partialEffects: [],
          exists: false,
          immutable: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}






type PublicSequenceProjection<T> = T extends readonly (infer Item)[]
  ? PublicSequenceProjection<Item>[]
  : T extends object
    ? {
        [Key in keyof T as Key extends string
          ? Lowercase<Key> extends `${string}${'path' | 'root' | 'locator'}`
            ? never
            : Key
          : Key]: PublicSequenceProjection<T[Key]>;
      }
    : T;

function stripPrivateSequenceLocators<T>(value: T): PublicSequenceProjection<T> {
  if (Array.isArray(value))
    return value.map(stripPrivateSequenceLocators) as PublicSequenceProjection<T>;
  if (!value || typeof value !== 'object') return value as PublicSequenceProjection<T>;
  const projected: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:path|root|locator)$/i.test(key)) continue;
    if (key === 'primerEditIntents' && Array.isArray(item)) {
      projected[key] = item.filter((intent) => intent?.field === 'pbsLength' || intent?.field === 'tailLength').map(stripPrivateSequenceLocators);
      continue;
    }
    projected[key] = stripPrivateSequenceLocators(item);
  }
  return projected as PublicSequenceProjection<T>;
}
