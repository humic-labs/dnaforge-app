   
                                                                              
              
  
                                                                         
                                                                               
                                                               
  
                                                                               
                                                                             
                                                                        
  
                                                                               
                                                                             
                                                                             
                                                                           
                                                                         
  
                                                                                
                                                                              
                                                                               
                                                                    
                                                                         
                                                                             
                                                                      
                                                                   
  
                                                                               
                                                                              
                                                                    
                                                                       
                                                           
  
                                                                               
                                                                              
                                                                             
                                                                             
                                                                                
                                                                              
                                                           
   

import {
  resultTool,
  toolSuccess,
  type ToolOperationResult,
} from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { useDesignStore } from '../../design/public/store';
import type { DesignRegion, SequenceDesign } from '../../design/public/types';
import {
  projectAssemblyGaps,
  projectAssemblySlots,
  slotOccupantFingerprint,
} from '../../design/public/slot-projection';
import { planRdFragmentAdd } from '../../design/public/rd-fragment-admission';
import {
  fragmentToRegion,
  sourceAnnotationsToDesignAnnotations,
} from '../../assembly-panel/public/utils/fragmentToRegion';
import {
  computeVirtualDigestAsync,
  throwIfVirtualDigestAborted,
  toDigestSourceAnnotations,
  VirtualDigestLimitError,
} from '../../assembly-panel/public/hooks/useVirtualDigest';
import { loadAllEnzymes } from '@waypoint/sequence-utils';
import { loadSequenceDocumentBiologyFile } from './path-utils';
import {
  buildDigestSnapshotId,
  buildFragmentCandidateId,
  MAX_DIGEST_ENZYMES,
  MAX_DIGEST_FRAGMENTS,
  MAX_DIGEST_SOURCE_BASES,
  resolveDigestEnzymes,
  resolveDigestTopology,
} from './virtual-digest';
import { createDesignMutationClaim } from './agent-mutation';
import { isGoldenGateSchemaStructureLocked } from '../../design/public/golden-gate-schema';

export const placeDigestFragmentSchema = z
  .object({
    designId: z.string().min(1).describe('Design id, or a waypoint://design/{id} URI.'),
    documentId: z
      .string()
      .min(1)
      .describe('The stable sequence document ID — the SAME ID you passed to virtual_digest.'),
    enzymes: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_DIGEST_ENZYMES)
      .describe('The SAME enzyme list you passed to virtual_digest.'),
    digestSnapshotId: z
      .string()
      .min(1)
      .describe(
        'The digestSnapshotId returned by virtual_digest. The digest is recomputed and refused ' +
          'if it no longer matches, which is how an edit to the source between your read and this ' +
          'write is caught instead of silently swapping which fragment you get.'
      ),
    fragmentCandidateId: z
      .string()
      .min(1)
      .describe('The fragmentCandidateId of the fragment you chose. Never an ordinal index.'),
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'A caller-generated key for this placement intent. Retrying the same inputs with the same ' +
          'key returns a noop with existingRegionId instead of placing a duplicate. Reusing the ' +
          'key for different inputs is refused.'
      ),
    mode: z
      .enum(['fill_empty', 'replace', 'insert_after', 'insert_before'])
      .describe(
        'fill_empty = put it in an EMPTY slot (refused if the slot is occupied). ' +
          'replace = overwrite an OCCUPIED slot, destroying what is there. ' +
          'insert_after / insert_before = create a NEW slot next to the target. ' +
          'There is no default: replacing is always an explicit choice.'
      ),
    targetRegionId: z
      .string()
      .min(1)
      .describe(
        'The slot to fill or replace, or the slot to insert next to. Read it from get_design.slots.'
      ),
    expectedSlotFingerprint: z
      .string()
      .min(1)
      .describe(
        'The occupantFingerprint of targetRegionId as you last saw it in get_design. Required for ' +
          'EVERY mode. If it no longer matches, the write is refused and the current slot map is ' +
          'returned — this is what makes it impossible to destroy something you have not looked at.'
      ),
    expectedDesignVersion: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Design version you last read. Omit and no concurrency guard runs.'),
  })
  .strict();

type PlaceDigestFragmentInput = z.infer<typeof placeDigestFragmentSchema>;

type PlacementResult = ToolOperationResult & {
  status?: string;
  placedRegionId?: string;
  placedOccupantFingerprint?: string;
  designVersion?: number;
};

type PlacementIdempotencyEntry = {
  signature: string;
  result: PlacementResult;
};

const completedPlacements = new Map<string, PlacementIdempotencyEntry>();
const DEFAULT_MAX_COMPLETED_PLACEMENTS = 1_000;
let maxCompletedPlacements = DEFAULT_MAX_COMPLETED_PLACEMENTS;
const retiredPlacementKeys = new Set<string>();
export const MAX_DIGEST_DESIGN_PERSISTED_BASES = MAX_DIGEST_SOURCE_BASES * 2;
const inFlightPlacements = new Map<
  string,
  { signature: string; promise: Promise<PlacementResult> }
>();

export function resetPlaceDigestFragmentIdempotencyForTests(): void {
  completedPlacements.clear();
  inFlightPlacements.clear();
  retiredPlacementKeys.clear();
  maxCompletedPlacements = DEFAULT_MAX_COMPLETED_PLACEMENTS;
}

export function setPlaceDigestFragmentIdempotencyLimitForTests(limit: number): void {
  maxCompletedPlacements = limit;
}

function placementSignature(input: PlaceDigestFragmentInput, designId: string): string {
  return JSON.stringify({ ...input, designId });
}

function reusedIdempotencyKey(
  base: Record<string, unknown>,
  idempotencyKey: string
): PlacementResult {
  return designToolFailure(
    'PLACE_DIGEST_FRAGMENT_FAILED',
    {
      ...base,
      status: 'rejected',
      code: 'IDEMPOTENCY_KEY_REUSED',
      error:
        `Idempotency key "${idempotencyKey}" was already used for different placement inputs. ` +
        'Generate a new key for a new intent.',
    },
    undefined
  );
}

function retiredIdempotencyKey(
  base: Record<string, unknown>,
  idempotencyKey: string
): PlacementResult {
  return designToolFailure(
    'PLACE_DIGEST_FRAGMENT_FAILED',
    {
      ...base,
      status: 'rejected',
      code: 'IDEMPOTENCY_REPLAY_EXPIRED',
      error:
        `Idempotency key "${idempotencyKey}" belongs to an older completed placement whose ` +
        'full replay record has expired. The key remains burned and cannot execute again.',
      revalidationRequired: true,
      remedy:
        'Re-read get_design. If another placement is still wanted, make a new decision with a fresh idempotencyKey.',
    },
    undefined
  );
}

function replayPlacement(
  result: PlacementResult,
  input: PlaceDigestFragmentInput,
  designId: string
): PlacementResult {
  const current = useDesignStore.getState().designs[designId];
  const placedRegion = current?.regions.find((region) => region.id === result.placedRegionId);
  const currentFingerprint = placedRegion ? slotOccupantFingerprint(placedRegion) : null;
  if (
    !placedRegion ||
    !result.placedOccupantFingerprint ||
    currentFingerprint !== result.placedOccupantFingerprint
  ) {
    return designToolFailure(
      'PLACE_DIGEST_FRAGMENT_FAILED',
      {
        status: 'rejected',
        code: 'IDEMPOTENCY_TARGET_CHANGED',
        designId,
        mode: input.mode,
        idempotencyKey: input.idempotencyKey,
        error:
          'The original placement no longer exists in the design, so this retry cannot be reported as a no-op.',
        existingRegionId: result.placedRegionId ?? null,
        expectedOccupantFingerprint: result.placedOccupantFingerprint ?? null,
        actualOccupantFingerprint: currentFingerprint,
        designVersion: current?.version ?? null,
        revalidationRequired: true,
        remedy:
          'Re-read get_design. If the fragment is still wanted, make a new placement decision with a fresh idempotencyKey.',
      },
      undefined
    );
  }
  if (result.designVersion !== undefined && current.version !== result.designVersion) {
    return designToolFailure(
      'PLACE_DIGEST_FRAGMENT_FAILED',
      {
        status: 'rejected',
        code: 'IDEMPOTENCY_DESIGN_CHANGED',
        designId,
        mode: input.mode,
        idempotencyKey: input.idempotencyKey,
        error:
          'The design changed after the original placement, so this retry cannot safely reuse its old slot and gap projection.',
        existingRegionId: result.placedRegionId ?? null,
        previousVersion: result.designVersion,
        currentVersion: current.version,
        slots: projectAssemblySlots(current),
        gaps: projectAssemblyGaps(current),
        revalidationRequired: true,
        retriable: true,
        remedy:
          'Re-read get_design. The original fragment is still present, but make any follow-up decision from the current slot and gap map.',
      },
      undefined
    );
  }
  const version = current?.version ?? result.designVersion;
  return toolSuccess({
    ...result,
    status: 'noop',
    applied: false,
    idempotentReplay: true,
    existingRegionId: result.placedRegionId ?? null,
    previousVersion: version,
    designVersion: version,
    revalidationRequired: false,
    mutation: createDesignMutationClaim({
      toolName: 'place_digest_fragment',
      effect: 'placed_digest_fragment',
      designId,
      beforeVersion: version,
      afterVersion: version,
      changed: false,
      expected: { mode: input.mode, targetRegionId: input.targetRegionId },
    }),
  });
}

function normalizeDesignId(input: string): string {
  if (!input.startsWith('waypoint://')) return input;
  try {
    const parsed = new URL(input);
    if (parsed.protocol === 'waypoint:' && parsed.hostname === 'design') {
      return decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    }
  } catch {
    return input;
  }
  return input;
}

   
                                                                               
                                                                                
                                                                           
                                                                               
                                                                               
                                                
   
function gapIdentities(design: SequenceDesign): Record<string, string> {
  const out: Record<string, string> = {};
  for (const gap of projectAssemblyGaps(design)) {
    if (!gap.spacer) continue;
    const left = design.regions[gap.junctionIndex];
    const right = design.regions[(gap.junctionIndex + 1) % design.regions.length];
    out[gap.spacer.id] = `${left?.id ?? '?'}→${right?.id ?? '?'}`;
  }
  return out;
}

function snapshot(design: SequenceDesign) {
  return {
    slots: projectAssemblySlots(design),
    gaps: projectAssemblyGaps(design),
    designVersion: design.version,
  };
}

export function createPlaceDigestFragmentTool(folders: WorkspaceFolder[]) {
  return resultTool({
    description:
      'Place a virtual-digest fragment into an assembly slot. An assembly is an ordered set of ' +
      'SLOTS and a slot can be EMPTY — read get_design.slots first to see which. You must always ' +
      "pass targetRegionId AND that slot's expectedSlotFingerprint, for every mode, so you can " +
      'never destroy contents you have not looked at. Use fill_empty for an empty slot, replace ' +
      'to deliberately overwrite an occupied one, and insert_after / insert_before to create a new ' +
      'slot next to an existing one (insertion is anchored to a slot, never to a numeric index, ' +
      'because indexes shift when anything is reordered). Supply a fresh idempotencyKey for each ' +
      'new placement intent; exact retries become a no-op instead of duplicating a part. The result ' +
      'returns the slot and gap map before and after, including any spacer whose junction identity changed.',
    inputSchema: placeDigestFragmentSchema as z.ZodTypeAny,
    execute: async (
      input: PlaceDigestFragmentInput,
      context?: { toolCallId?: string; abortSignal?: AbortSignal }
    ) =>
      runDesignTool('PLACE_DIGEST_FRAGMENT_FAILED', async (effects) => {
        throwIfVirtualDigestAborted(context?.abortSignal);
        const designId = normalizeDesignId(input.designId);
        const base = { designId, mode: input.mode, idempotencyKey: input.idempotencyKey };
        const idempotencyMapKey = `${designId}:${input.idempotencyKey}`;
        const signature = placementSignature(input, designId);

        if (retiredPlacementKeys.has(idempotencyMapKey)) {
          return retiredIdempotencyKey(base, input.idempotencyKey);
        }

        const completed = completedPlacements.get(idempotencyMapKey);
        if (completed) {
          return completed.signature === signature
            ? replayPlacement(completed.result, input, designId)
            : reusedIdempotencyKey(base, input.idempotencyKey);
        }

        const inFlight = inFlightPlacements.get(idempotencyMapKey);
        if (inFlight) {
          if (inFlight.signature !== signature) {
            return reusedIdempotencyKey(base, input.idempotencyKey);
          }
          const result = await inFlight.promise;
          return result.status === 'applied' ? replayPlacement(result, input, designId) : result;
        }

        const operation = (async (): Promise<PlacementResult> => {
          try {
            throwIfVirtualDigestAborted(context?.abortSignal);
            const store = useDesignStore.getState();
            const design = store.designs[designId];
            if (!design) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                {
                  ...base,
                  status: 'rejected',
                  code: 'design-not-found',
                  error: `Design not found: ${designId}`,
                },
                effects
              );
            }

            const before = snapshot(design);
            const withMap = (extra: Record<string, unknown>) => ({
              ...base,
              ...extra,
              slots: before.slots,
              gaps: before.gaps,
            });

            if (
              isGoldenGateSchemaStructureLocked(design.goldenGateSchema) &&
              (input.mode === 'insert_before' || input.mode === 'insert_after')
            ) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                withMap({
                  status: 'rejected',
                  code: 'SCHEMA_STRUCTURE_LOCKED',
                  error:
                    'This reusable Golden Gate schema fixes the slot count and order. Fill or replace an existing slot, or clear the schema first.',
                }),
                effects
              );
            }

            if (
              input.expectedDesignVersion !== undefined &&
              input.expectedDesignVersion !== design.version
            ) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                withMap({
                  status: 'rejected',
                  code: 'stale-design-version',
                  error: `The design is at version ${design.version}, not ${input.expectedDesignVersion}.`,
                  currentVersion: design.version,
                  retriable: true,
                }),
                effects
              );
            }

            const targetIndex = design.regions.findIndex(
              (region) => region.id === input.targetRegionId
            );
            if (targetIndex === -1) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                withMap({
                  status: 'rejected',
                  code: 'slot-not-found',
                  error: `No slot with id ${input.targetRegionId}.`,
                  remedy: 'Read get_design.slots and use one of the regionId values listed there.',
                }),
                effects
              );
            }

            const target = design.regions[targetIndex];
            const actualFingerprint = slotOccupantFingerprint(target);
            if (actualFingerprint !== input.expectedSlotFingerprint) {
                                                                                    
                                            
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                withMap({
                  status: 'rejected',
                  code: 'SLOT_CHANGED',
                  error:
                    `Slot ${targetIndex} has changed since you read it. Someone else may have edited ` +
                    `this design.`,
                  expectedSlotFingerprint: input.expectedSlotFingerprint,
                  actualSlotFingerprint: actualFingerprint,
                  remedy:
                    'Re-read get_design, decide again, and retry with the current fingerprint.',
                  retriable: true,
                }),
                effects
              );
            }

            if (input.mode === 'fill_empty' && !target.isPlaceholder) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                withMap({
                  status: 'rejected',
                  code: 'SLOT_OCCUPIED',
                  error: `Slot ${targetIndex} is not empty — it holds "${target.sourceSequenceName}".`,
                  remedy:
                    'Use mode "replace" if you intend to destroy that part, or "insert_before" / ' +
                    '"insert_after" to add a new slot without touching it.',
                }),
                effects
              );
            }
            if (input.mode === 'replace' && target.isPlaceholder) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                withMap({
                  status: 'rejected',
                  code: 'SLOT_ALREADY_EMPTY',
                  error: `Slot ${targetIndex} is already empty; there is nothing to replace.`,
                  remedy: 'Use mode "fill_empty".',
                }),
                effects
              );
            }

                                                                                   
            const loaded = await loadSequenceDocumentBiologyFile(input.documentId, folders);
            const parsed = loaded.biology;
            throwIfVirtualDigestAborted(context?.abortSignal);

            const sequence = parsed.sequence.sequence;
            if (!sequence || sequence.length === 0) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                withMap({
                  status: 'rejected',
                  code: 'EMPTY_SEQUENCE',
                  error: 'That file contains no bases.',
                }),
                effects
              );
            }
            if (sequence.length > MAX_DIGEST_SOURCE_BASES) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                withMap({
                  status: 'rejected',
                  code: 'SOURCE_TOO_LARGE_FOR_DESIGN',
                  error:
                    `That sequence is ${sequence.length.toLocaleString()} bp, above the ` +
                    `${MAX_DIGEST_SOURCE_BASES.toLocaleString()} bp design-embedding limit.`,
                  length: sequence.length,
                  limit: MAX_DIGEST_SOURCE_BASES,
                }),
                effects
              );
            }
            const catalog = await loadAllEnzymes();
            throwIfVirtualDigestAborted(context?.abortSignal);
            const { resolvedEnzymes, unknown } = resolveDigestEnzymes(input.enzymes, catalog);
            if (unknown.length > 0) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                withMap({
                  status: 'rejected',
                  code: 'UNKNOWN_ENZYME',
                  error: `Not in the restriction-enzyme catalog: ${unknown.join(', ')}.`,
                }),
                effects
              );
            }

            const { circular } = resolveDigestTopology(parsed);
            const snapshotId = buildDigestSnapshotId({
              sequence,
              circular,
              enzymeNames: resolvedEnzymes.map((enzyme) => enzyme.name),
              sourceDocumentId: loaded.documentId,
              annotations: parsed.sequence.annotations,
            });
            if (snapshotId !== input.digestSnapshotId) {
                                                                                    
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                withMap({
                  status: 'rejected',
                  code: 'DIGEST_SNAPSHOT_STALE',
                  error:
                    'This digest no longer matches the one you read. The source path, sequence, ' +
                    'annotations, topology, or enzyme set has changed.',
                  expectedDigestSnapshotId: input.digestSnapshotId,
                  actualDigestSnapshotId: snapshotId,
                  remedy: 'Re-run virtual_digest and choose a fragment from the fresh result.',
                  retriable: true,
                }),
                effects
              );
            }

            let digest;
            try {
              digest = await computeVirtualDigestAsync(
                sequence,
                resolvedEnzymes,
                toDigestSourceAnnotations(parsed.sequence.annotations),
                                                                                    
                                                                                 
                                                                                 
                                                                                  
                                                                              
                                                                                  
                {
                  circular,
                  maxFragments: MAX_DIGEST_FRAGMENTS,
                  abortSignal: context?.abortSignal,
                }
              );
              throwIfVirtualDigestAborted(context?.abortSignal);
            } catch (error) {
              if ((error as Error).name === 'AbortError' || context?.abortSignal?.aborted) {
                throwIfVirtualDigestAborted(context?.abortSignal);
                throw error;
              }
              if (!(error instanceof VirtualDigestLimitError)) throw error;
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                withMap({
                  status: 'rejected',
                  code: 'TOO_MANY_FRAGMENTS',
                  error:
                    `That digest produces at least ${error.fragmentCount} fragments, above the ` +
                    `${error.limit} limit. Use a rarer cutter.`,
                  fragmentCount: error.fragmentCount,
                  limit: error.limit,
                }),
                effects
              );
            }
            const fragment = digest.fragments.find(
              (candidate) =>
                buildFragmentCandidateId(snapshotId, candidate) === input.fragmentCandidateId
            );
            if (!fragment) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                withMap({
                  status: 'rejected',
                  code: 'FRAGMENT_NOT_FOUND',
                  error: `No fragment in this digest matches ${input.fragmentCandidateId}.`,
                  availableFragmentIds: digest.fragments.map((candidate) =>
                    buildFragmentCandidateId(snapshotId, candidate)
                  ),
                }),
                effects
              );
            }

            const built = fragmentToRegion({
              fragment,
              sourceSequence: sequence,
              sourceSequenceId: loaded.documentId,
              sourceSequenceName: parsed.sequence.name ?? loaded.documentId,
              overhangLength: digest.overhangLength,
              enzymeName: resolvedEnzymes.map((enzyme) => enzyme.name).join(' + '),
              sourceAnnotations: sourceAnnotationsToDesignAnnotations(parsed.sequence.annotations),
              sourceIsCircular: circular,
              allFragments: digest.fragments,
            });

                                                                                     
                                                                                
                                                                    
            const currentDesign = useDesignStore.getState().designs[designId];
            if (!currentDesign) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                withMap({
                  status: 'rejected',
                  code: 'design-not-found',
                  error: `Design not found: ${designId}`,
                }),
                effects
              );
            }
            if (currentDesign.version !== design.version) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                {
                  ...base,
                  status: 'rejected',
                  code: 'stale-design-version',
                  error:
                    'The design changed while the digest source was being resolved. Re-read get_design ' +
                    'and retry with the current slot fingerprint.',
                  previousVersion: design.version,
                  currentVersion: currentDesign.version,
                  slots: projectAssemblySlots(currentDesign),
                  gaps: projectAssemblyGaps(currentDesign),
                  retriable: true,
                },
                effects
              );
            }
            const currentTargetIndex = currentDesign.regions.findIndex(
              (region) => region.id === input.targetRegionId
            );
            if (currentTargetIndex === -1) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                {
                  ...base,
                  status: 'rejected',
                  code: 'slot-not-found',
                  error: `No slot with id ${input.targetRegionId}.`,
                  slots: projectAssemblySlots(currentDesign),
                  gaps: projectAssemblyGaps(currentDesign),
                  retriable: true,
                },
                effects
              );
            }
            const currentTarget = currentDesign.regions[currentTargetIndex];
            const currentFingerprint = slotOccupantFingerprint(currentTarget);
            if (currentFingerprint !== input.expectedSlotFingerprint) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                {
                  ...base,
                  status: 'rejected',
                  code: 'SLOT_CHANGED',
                  error: `Slot ${currentTargetIndex} changed while the digest source was being resolved.`,
                  expectedSlotFingerprint: input.expectedSlotFingerprint,
                  actualSlotFingerprint: currentFingerprint,
                  slots: projectAssemblySlots(currentDesign),
                  gaps: projectAssemblyGaps(currentDesign),
                  retriable: true,
                },
                effects
              );
            }
            if (input.mode === 'fill_empty' && !currentTarget.isPlaceholder) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                {
                  ...base,
                  status: 'rejected',
                  code: 'SLOT_OCCUPIED',
                  error: `Slot ${currentTargetIndex} is no longer empty.`,
                  slots: projectAssemblySlots(currentDesign),
                  gaps: projectAssemblyGaps(currentDesign),
                },
                effects
              );
            }
            if (input.mode === 'replace' && currentTarget.isPlaceholder) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                {
                  ...base,
                  status: 'rejected',
                  code: 'SLOT_ALREADY_EMPTY',
                  error: `Slot ${currentTargetIndex} is now empty; there is nothing to replace.`,
                  slots: projectAssemblySlots(currentDesign),
                  gaps: projectAssemblyGaps(currentDesign),
                },
                effects
              );
            }

                                                                                
                                                                                    
                                                                                   
                                                                                 
                                                                                  
                                                                               
            const regionsAfterReplacement =
              input.mode === 'replace'
                ? currentDesign.regions.filter((region) => region.id !== currentTarget.id)
                : currentDesign.regions;
            const persistedBases = regionsAfterReplacement.reduce(
              (total, region) =>
                total + region.sequence.length + (region.sourceSequence?.length ?? 0),
              0
            );
            const requestedRegionBases = built.sequence.length;
            const requestedSourceBases = built.sourceSequence?.length ?? 0;
            const projectedPersistedBases =
              persistedBases + requestedRegionBases + requestedSourceBases;
            if (projectedPersistedBases > MAX_DIGEST_DESIGN_PERSISTED_BASES) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                withMap({
                  status: 'rejected',
                  code: 'DESIGN_SOURCE_BUDGET_EXCEEDED',
                  error:
                    `Placing this fragment would put the design at ` +
                    `${projectedPersistedBases.toLocaleString()} persisted DNA bases, above the ` +
                    `${MAX_DIGEST_DESIGN_PERSISTED_BASES.toLocaleString()} bp safety limit.`,
                  persistedBases,
                  requestedRegionBases,
                  requestedSourceBases,
                  projectedPersistedBases,
                  limit: MAX_DIGEST_DESIGN_PERSISTED_BASES,
                  remedy: 'Remove a large part or embedded source before placing this fragment.',
                }),
                effects
              );
            }

                                                                                   
                                                                                  
                                                                                 
                                                                                 
                                                  
            const admissionDesign =
              input.mode === 'replace'
                ? {
                    ...currentDesign,
                    regions: currentDesign.regions.filter(
                      (region) => region.id !== currentTarget.id
                    ),
                  }
                : currentDesign;
            const admission = planRdFragmentAdd(admissionDesign, built);
            if (!admission.allowed) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                withMap({
                  status: 'rejected',
                  code: admission.code,
                  error: admission.reason,
                  remedy: admission.remedy,
                  existingEnzyme: admission.existingEnzyme ?? null,
                  incomingEnzyme: admission.incomingEnzyme ?? null,
                }),
                effects
              );
            }

                                                                                  
            const beforeIdentities = gapIdentities(currentDesign);
            effects.attemptedMutation();
            if (admission.adoptEnzyme) {
                                                                                   
                                                                                
                                                                             
              useDesignStore
                .getState()
                .setAssemblyMethod(designId, 'goldengate', admission.adoptEnzyme);
            }

            if (input.mode === 'fill_empty' || input.mode === 'replace') {
                                                                              
                                                                                 
                                                                        
              useDesignStore.getState().updateRegion(designId, currentTarget.id, {
                ...built,
                isPlaceholder: false,
                ggType: built.ggType ?? undefined,
                rdOverhangs: built.rdOverhangs ?? undefined,
                rdSourceEnzyme: built.rdSourceEnzyme ?? undefined,
                rdSourceEnzymeName: built.rdSourceEnzymeName ?? undefined,
                rdEnds: built.rdEnds ?? undefined,
                rdSiblingOverhangs: built.rdSiblingOverhangs ?? undefined,
              } as Partial<DesignRegion>);
            } else {
              const insertIndex =
                input.mode === 'insert_after' ? currentTargetIndex + 1 : currentTargetIndex;
              useDesignStore.getState().insertRegionAt(designId, insertIndex, built);
            }

            effects.changed({
              kind: 'digest-fragment-placed',
              designId,
              targetRegionId: input.targetRegionId,
            });
            const after = useDesignStore.getState().designs[designId];
            const placedRegionId =
              input.mode === 'fill_empty' || input.mode === 'replace'
                ? currentTarget.id
                : after.regions[
                    input.mode === 'insert_after' ? currentTargetIndex + 1 : currentTargetIndex
                  ]?.id;
            const afterIdentities = gapIdentities(after);
            const placedRegion = after.regions.find((region) => region.id === placedRegionId);
            if (!placedRegion) {
              return designToolFailure(
                'PLACE_DIGEST_FRAGMENT_FAILED',
                {
                  ...base,
                  status: 'rejected',
                  code: 'PLACEMENT_NOT_COMMITTED',
                  error:
                    'The placement write returned without the placed region present in the design.',
                  revalidationRequired: true,
                },
                effects
              );
            }
            const placedOccupantFingerprint = slotOccupantFingerprint(placedRegion);
            const movedSpacers = Object.entries(beforeIdentities)
              .filter(([spacerId, identity]) => afterIdentities[spacerId] !== identity)
              .map(([spacerId, identity]) => ({
                spacerId,
                wasBetween: identity,
                nowBetween: afterIdentities[spacerId] ?? '(removed)',
              }));

            return toolSuccess({
              ...base,
              status: 'applied',
              applied: true,
              placedRegionId,
              placedOccupantFingerprint,
              slotsBefore: before.slots,
              slots: projectAssemblySlots(after),
              gapsBefore: before.gaps,
              gaps: projectAssemblyGaps(after),
                                                                                  
                                                                                    
                                            
              movedSpacers,
              replaced:
                input.mode === 'replace'
                  ? {
                      regionId: currentTarget.id,
                      label: currentTarget.sourceSequenceName,
                      length: currentTarget.sequence.length,
                      ggType: currentTarget.ggType ?? null,
                      rdSourceEnzyme: currentTarget.rdSourceEnzyme ?? null,
                    }
                  : null,
              previousVersion: currentDesign.version,
              designVersion: after.version,
              versionGuardApplied: input.expectedDesignVersion !== undefined,
              revalidationRequired: true,
              adoptedGoldenGateEnzyme: admission.adoptEnzyme ?? null,
              mutation: createDesignMutationClaim({
                operationId: context?.toolCallId,
                toolName: 'place_digest_fragment',
                effect: 'placed_digest_fragment',
                designId,
                beforeVersion: currentDesign.version,
                afterVersion: after.version,
                changed: true,
                expected: { mode: input.mode, targetRegionId: input.targetRegionId },
              }),
            });
          } catch (error) {
            if ((error as Error).name === 'AbortError' || context?.abortSignal?.aborted) {
              throwIfVirtualDigestAborted(context?.abortSignal);
              throw error;
            }
            return designToolFailure(
              'PLACE_DIGEST_FRAGMENT_FAILED',
              {
                ...base,
                status: 'rejected',
                code: 'EXECUTION_FAILED',
                error: `Failed to place digest fragment: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
              effects
            );
          }
        })();

        inFlightPlacements.set(idempotencyMapKey, { signature, promise: operation });
        try {
          const result = await operation;
          if (result.status === 'applied') {
            if (completedPlacements.size >= maxCompletedPlacements) {
              const oldest = completedPlacements.keys().next().value;
              if (oldest !== undefined) {
                completedPlacements.delete(oldest);
                retiredPlacementKeys.add(oldest);
              }
            }
            completedPlacements.set(idempotencyMapKey, { signature, result });
          }
          return result;
        } finally {
          const current = inFlightPlacements.get(idempotencyMapKey);
          if (current?.promise === operation) inFlightPlacements.delete(idempotencyMapKey);
        }
      }),
  });
}

export const placeDigestFragmentTool = createPlaceDigestFragmentTool([]);
