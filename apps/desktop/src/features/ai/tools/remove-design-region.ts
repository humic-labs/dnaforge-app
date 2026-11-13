   
                                                                    
  
                                                                               
                                                                                  
                                                                               
                                                                              
                                                                                 
                            
  
                                                                               
                                                                                    
                                                                              
                                                                              
                                                                
                                                                                 
                                                               
  
                                                                            
                                                                           
                                                                            
                                                                              
                                                                            
                                             
  
                                                                               
                                                                               
                                                                              
                                                                             
                                                                                
                                                                           
                                                                                
                                                                                 
                                                                   
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import { assemblyDispatcher, useDesignStore } from '../../design/public/store';
import { slotOccupantFingerprint } from '../../design/public/slot-projection';
import {
  assemblySnapshot,
  diffSpacers,
  draftDiscardedBy,
  isRetriableRefusal,
  refusalCode,
  refusalRemedy,
} from './assembly-edit-report';
import { createDesignMutationClaim } from './agent-mutation';
import { isGoldenGateSchemaStructureLocked } from '../../design/public/golden-gate-schema';

export const MAX_INLINE_REMOVED_REGION_BP = 50_000;
const REMOVED_REGION_PREVIEW_BP = 1_000;

export const removeDesignRegionSchema = z
  .object({
    designId: z
      .string()
      .min(1)
      .describe('Design id returned by create_design, or a waypoint://design/{id} URI.'),
    regionId: z
      .string()
      .min(1)
      .describe(
        'The slot to remove, addressed by the `regionId` shown in get_design.slots. Never an ' +
          'ordinal position — positions are renumbered by every edit.'
      ),
    expectedSlotFingerprint: z
      .string()
      .min(1)
      .describe(
        'The `occupantFingerprint` of that slot exactly as get_design.slots reported it. REQUIRED. ' +
          'It hashes the slot CONTENT, and a slot keeps its id when it is cleared or refilled, so ' +
          'the id alone cannot prove you know what you are deleting. If it no longer matches, the ' +
          'removal is refused with SLOT_CHANGED and the current slot map is returned.'
      ),
    expectedDesignVersion: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'The design `version` you last read. If it has moved on, the removal is refused with ' +
          'stale-design-version instead of applying to a design you have not seen. Omitting it ' +
          'does NOT disable the guard — the version read at call time is still used, so a ' +
          'concurrent edit cannot slip in. `versionGuardApplied` reports whether YOU supplied one.'
      ),
  })
  .strict();

type RemoveDesignRegionInput = z.infer<typeof removeDesignRegionSchema>;

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

export const removeDesignRegionTool = resultTool({
  description:
    'Remove a part from an assembly design — the undo for add_design_region and ' +
    'place_digest_fragment. An assembly is an ordered set of SLOTS; this deletes the slot ' +
    'entirely and closes the gap, shortening the assembly by one. (To keep the position but ' +
    'empty it, that is a different operation and this tool does not do it.) You must pass the ' +
    "slot's `regionId` AND the `occupantFingerprint` you read from get_design.slots, so you can " +
    'never delete something you have not looked at. The result returns the slot map and gap map ' +
    'BEFORE and AFTER, and — read this — any spacer that moved or was DROPPED: a spacer is real ' +
    'DNA in the gap between two parts, and if those two parts stop being neighbours the spacer is ' +
    'removed from the construct. Its sequence is returned so you can place it again deliberately. ' +
    'The removed part sequence is returned inline only up to 50,000 bp; larger parts return a ' +
    'bounded preview plus their source path and coordinates, so the write cannot succeed and then ' +
    'lose its response to an oversized tool payload. Removing a part also discards the drafted ' +
    'assembly (homology arms, designed primers, Golden ' +
    'Gate junctions); call draft_design_assembly afterwards to rebuild and re-validate.',
  inputSchema: removeDesignRegionSchema as z.ZodTypeAny,
  execute: async (input: RemoveDesignRegionInput, context?: { toolCallId?: string }) =>
    runDesignTool('REMOVE_DESIGN_REGION_FAILED', async (effects) => {
      const designId = normalizeDesignId(input.designId);
      const base = {
        designId,
        regionId: input.regionId,
        versionGuardApplied: input.expectedDesignVersion !== undefined,
        revalidationRequired: false,
      };

      try {
        const design = useDesignStore.getState().designs[designId];
        if (!design) {
          return designToolFailure(
            'REMOVE_DESIGN_REGION_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'design-not-found',
              error: `Design not found: ${designId}`,
              remedy: 'Call get_workspace or create_design; a design id is not a file path.',
            },
            effects
          );
        }
        if (isGoldenGateSchemaStructureLocked(design.goldenGateSchema)) {
          return designToolFailure(
            'REMOVE_DESIGN_REGION_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'SCHEMA_STRUCTURE_LOCKED',
              error:
                'This reusable Golden Gate schema fixes the slot count. Clear the part instead of deleting its slot, or clear the schema first.',
              designVersion: design.version,
            },
            effects
          );
        }

        const before = assemblySnapshot(design);
        const withMap = (extra: Record<string, unknown>) => ({
          ...base,
          ...extra,
          slots: before.slots,
          gaps: before.gaps,
          designVersion: design.version,
        });

        if (
          input.expectedDesignVersion !== undefined &&
          input.expectedDesignVersion !== design.version
        ) {
          return designToolFailure(
            'REMOVE_DESIGN_REGION_FAILED',
            withMap({
              status: 'rejected' as const,
              code: 'stale-design-version',
              error: `The design is at version ${design.version}, not ${input.expectedDesignVersion}.`,
              currentVersion: design.version,
              remedy: 'Re-read with get_design and retry with the current version and fingerprint.',
              retriable: true,
            }),
            effects
          );
        }

        const targetIndex = design.regions.findIndex((region) => region.id === input.regionId);
        if (targetIndex === -1) {
          return designToolFailure(
            'REMOVE_DESIGN_REGION_FAILED',
            withMap({
              status: 'rejected' as const,
              code: 'slot-not-found',
              error: `No slot with id ${input.regionId} in this design.`,
              knownRegionIds: design.regions.map((region) => region.id),
              remedy:
                'Read get_design.slots and use one of the regionId values listed there. If you already ' +
                'removed this part, it is gone — nothing further is needed.',
            }),
            effects
          );
        }

        const target = design.regions[targetIndex];
        const actualFingerprint = slotOccupantFingerprint(target);
        if (actualFingerprint !== input.expectedSlotFingerprint) {
                                                                                   
                                                                                    
                                                                                 
          return designToolFailure(
            'REMOVE_DESIGN_REGION_FAILED',
            withMap({
              status: 'rejected' as const,
              code: 'SLOT_CHANGED',
              error:
                `Slot ${targetIndex} (${target.sourceSequenceName}) has changed since you read it. ` +
                'Someone else may have edited this design, or you already acted on it.',
              expectedSlotFingerprint: input.expectedSlotFingerprint,
              actualSlotFingerprint: actualFingerprint,
              remedy: 'Re-read get_design, decide again, and retry with the current fingerprint.',
              retriable: true,
            }),
            effects
          );
        }

        const previousVersion = design.version;
        const discardedDraft = draftDiscardedBy(design);
        const sequenceIncluded = target.sequence.length <= MAX_INLINE_REMOVED_REGION_BP;
        const removed = {
          regionId: target.id,
          slotIndex: targetIndex,
          label: target.sourceSequenceName,
          wasEmpty: target.isPlaceholder === true,
          length: target.sequence.length,
          sourceSequenceId: target.sourceSequenceId,
          sourceStart: target.sourceStart,
          sourceEnd: target.sourceEnd,
          sourceType: target.sourceType ?? null,
          ggType: target.ggType ?? null,
          rdSourceEnzyme: target.rdSourceEnzyme ?? null,
          sequenceIncluded,
          ...(sequenceIncluded
            ? {
                                                                            
                sequence: target.sequence,
              }
            : {
                sequencePreview: target.sequence.slice(0, REMOVED_REGION_PREVIEW_BP),
                sequencePreviewLength: REMOVED_REGION_PREVIEW_BP,
                recovery:
                  'Re-read sourceSequenceId and restore sourceStart..sourceEnd; the full sequence was not inlined.',
              }),
        };

                                                                                  
                                                                                   
                                                                      
        effects.attemptedMutation();
        const dispatch = await assemblyDispatcher.dispatch({
          type: 'removeFragment',
          designId,
          fragmentId: input.regionId,
          expectedVersion: input.expectedDesignVersion ?? previousVersion,
        }).result;

        if (!dispatch.ok) {
          effects.unchanged();
          const current = useDesignStore.getState().designs[designId];
          return designToolFailure(
            'REMOVE_DESIGN_REGION_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: refusalCode(dispatch.error),
              error: dispatch.error.message,
              remedy: refusalRemedy(dispatch.error),
              retriable: isRetriableRefusal(dispatch.error),
              refusal: dispatch.error,
              currentVersion: current?.version ?? null,
              slots: current ? assemblySnapshot(current).slots : before.slots,
              gaps: current ? assemblySnapshot(current).gaps : before.gaps,
            },
            effects
          );
        }

        effects.changed({ kind: 'design-edited', designId });
        const next = useDesignStore.getState().designs[designId];
        const after = assemblySnapshot(next);
        const { movedSpacers, droppedSpacers } = diffSpacers(before.spacers, after.spacers);

        return toolSuccess({
          ...base,
          status: 'applied' as const,
          removed,
          slotsBefore: before.slots,
          slots: after.slots,
          gapsBefore: before.gaps,
          gaps: after.gaps,
          slotCountBefore: before.slotCount,
          slotCount: after.slotCount,
          composedLengthBefore: before.composedLength,
          composedLength: after.composedLength,
                                                                              
                                                                             
                                                                                   
                                                                
          movedSpacers,
          droppedSpacers,
          orphanedSpacerIds: after.orphanedSpacerIds,
                                                                                 
                                         
          discardedDraft,
          previousVersion,
          designVersion: next.version,
          changedFields: dispatch.value.changedFields,
                                                                            
                                                                              
          revalidationRequired: true,
          mutation: createDesignMutationClaim({
            operationId: context?.toolCallId,
            toolName: 'remove_design_region',
            effect: 'removed_design_region',
            designId,
            beforeVersion: previousVersion,
            afterVersion: next.version,
            changed: true,
            expected: {
              regionId: input.regionId,
              slotCount: after.slotCount,
            },
          }),
        });
      } catch (error) {
        return designToolFailure(
          'REMOVE_DESIGN_REGION_FAILED',
          {
            ...base,
            status: 'rejected' as const,
            code: 'EXECUTION_FAILED',
            error: `Failed to remove design region: ${
              error instanceof Error ? error.message : String(error)
            }`,
            remedy: 'Re-read the design with get_design before retrying.',
          },
          effects
        );
      }
    }),
});
