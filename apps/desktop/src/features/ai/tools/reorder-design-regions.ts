   
                                                                             
              
  
                                                                              
                                                                              
                                               
  
                                                                               
                                                                               
                                                                               
                                                                              
                                                                            
                                    
  
                                                                              
                                                                                
                                                                               
                                                                          
                                                                                
                                                                                
                               
  
                                                                               
                                                                           
                                                                              
                                                                   
                                                                               
                                                                  
  
                                                                               
                             
  
                                                                              
                                                                             
                                                                              
                                                                               
                                                                                
                                                
                                                                             
                                                                               
                    
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import { assemblyDispatcher, useDesignStore } from '../../design/public/store';
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

export const reorderDesignRegionsSchema = z
  .object({
    designId: z
      .string()
      .min(1)
      .describe('Design id returned by create_design, or a waypoint://design/{id} URI.'),
    order: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        'The COMPLETE new left-to-right order of the assembly, as region ids. It must be a ' +
          'permutation of exactly the ids currently in the design: every current id present, ' +
          'exactly once, and nothing else. Read them from get_design.slots[].regionId. This is a ' +
          'full ordering, not a move instruction — there is no "move part X to position 3".'
      ),
    expectedDesignVersion: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'The design `version` you last read. Strongly recommended here: the ids can still be a ' +
          'valid permutation after someone has replaced what is INSIDE one of those slots, and ' +
          'only the version guard catches that. If it has moved on, the reorder is refused with ' +
          'stale-design-version. `versionGuardApplied` reports whether you supplied one.'
      ),
  })
  .strict();

type ReorderDesignRegionsInput = z.infer<typeof reorderDesignRegionsSchema>;

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

   
                                                                                
  
                                                                             
                                                                            
                                                                                
         
   
function permutationProblems(order: readonly string[], currentIds: readonly string[]) {
  const currentSet = new Set(currentIds);
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  const unknownIds: string[] = [];

  for (const id of order) {
    if (seen.has(id)) {
      if (!duplicateIds.includes(id)) duplicateIds.push(id);
    } else {
      seen.add(id);
    }
    if (!currentSet.has(id) && !unknownIds.includes(id)) unknownIds.push(id);
  }

  const missingIds = currentIds.filter((id) => !seen.has(id));
  return { duplicateIds, unknownIds, missingIds };
}

export const reorderDesignRegionsTool = resultTool({
  description:
    'Reorder the parts of an assembly design. Pass the COMPLETE new order as region ids — a ' +
    'permutation of exactly the ids currently in the design, read from get_design.slots. There is ' +
    'no move-one-part form: a full ordering has exactly one meaning, while "move X to index 3" ' +
    'does not. If the list is not a permutation the call is refused and the missing, extra and ' +
    'duplicated ids are named. The result returns the slot map and gap map BEFORE and AFTER, plus ' +
    'any spacer that moved or was DROPPED — a spacer is real DNA sitting between two specific ' +
    'parts, so reordering those two apart removes it from the construct, and its sequence is ' +
    'returned so you can place it again with set_junction_spacer. A reorder also discards the ' +
    'drafted assembly (homology arms, designed primers, Golden Gate junctions); call ' +
    'draft_design_assembly afterwards to rebuild and re-validate.',
  inputSchema: reorderDesignRegionsSchema as z.ZodTypeAny,
  execute: async (input: ReorderDesignRegionsInput, context?: { toolCallId?: string }) =>
    runDesignTool('REORDER_DESIGN_REGIONS_FAILED', async (effects) => {
      const designId = normalizeDesignId(input.designId);
      const base = {
        designId,
        versionGuardApplied: input.expectedDesignVersion !== undefined,
        revalidationRequired: false,
      };

      try {
        const design = useDesignStore.getState().designs[designId];
        if (!design) {
          return designToolFailure(
            'REORDER_DESIGN_REGIONS_FAILED',
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
            'REORDER_DESIGN_REGIONS_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'SCHEMA_STRUCTURE_LOCKED',
              error:
                'This reusable Golden Gate schema fixes the slot order. Fill or replace a slot, or clear the schema before reordering parts.',
              designVersion: design.version,
            },
            effects
          );
        }

        const before = assemblySnapshot(design);
        const currentOrder = design.regions.map((region) => region.id);
        const withMap = (extra: Record<string, unknown>) => ({
          ...base,
          ...extra,
          slots: before.slots,
          gaps: before.gaps,
          currentOrder,
          designVersion: design.version,
        });

        if (
          input.expectedDesignVersion !== undefined &&
          input.expectedDesignVersion !== design.version
        ) {
          return designToolFailure(
            'REORDER_DESIGN_REGIONS_FAILED',
            withMap({
              status: 'rejected' as const,
              code: 'stale-design-version',
              error: `The design is at version ${design.version}, not ${input.expectedDesignVersion}.`,
              currentVersion: design.version,
              remedy: 'Re-read with get_design and build the order from the ids it reports.',
              retriable: true,
            }),
            effects
          );
        }

        if (currentOrder.length < 2) {
                                                                                  
                                                                                   
                                     
          return designToolFailure(
            'REORDER_DESIGN_REGIONS_FAILED',
            withMap({
              status: 'rejected' as const,
              code: 'NOTHING_TO_REORDER',
              error: `This design has ${currentOrder.length} part(s); there is no order to change.`,
              remedy: 'Add parts with add_design_region or place_digest_fragment first.',
            }),
            effects
          );
        }

        const { duplicateIds, unknownIds, missingIds } = permutationProblems(
          input.order,
          currentOrder
        );
        if (duplicateIds.length > 0 || unknownIds.length > 0 || missingIds.length > 0) {
          return designToolFailure(
            'REORDER_DESIGN_REGIONS_FAILED',
            withMap({
              status: 'rejected' as const,
              code: 'ORDER_NOT_A_PERMUTATION',
              error:
                'order must list every region id currently in the design exactly once. ' +
                [
                  missingIds.length > 0 ? `Missing: ${missingIds.join(', ')}.` : '',
                  unknownIds.length > 0 ? `Not in this design: ${unknownIds.join(', ')}.` : '',
                  duplicateIds.length > 0
                    ? `Listed more than once: ${duplicateIds.join(', ')}.`
                    : '',
                ]
                  .filter(Boolean)
                  .join(' '),
              missingIds,
              unknownIds,
              duplicateIds,
              expectedLength: currentOrder.length,
              receivedLength: input.order.length,
              remedy:
                'Take get_design.slots[].regionId as the id set, rearrange that exact list, and send ' +
                'it back whole.',
            }),
            effects
          );
        }

        if (input.order.every((id, index) => id === currentOrder[index])) {
                                                                                
                                                
          return designToolFailure(
            'REORDER_DESIGN_REGIONS_FAILED',
            withMap({
              status: 'rejected' as const,
              code: 'ORDER_UNCHANGED',
              error: 'The design is already in this order.',
              remedy:
                'Nothing to do. Applying it anyway would discard the drafted primers and homology ' +
                'arms for no change.',
            }),
            effects
          );
        }

        const previousVersion = design.version;
        const discardedDraft = draftDiscardedBy(design);

                                                                                  
                                                                                   
                                                                      
        effects.attemptedMutation();
        const dispatch = await assemblyDispatcher.dispatch({
          type: 'reorderFragments',
          designId,
          order: input.order,
          expectedVersion: input.expectedDesignVersion ?? previousVersion,
        }).result;

        if (!dispatch.ok) {
          effects.unchanged();
          const current = useDesignStore.getState().designs[designId];
          const snapshot = current ? assemblySnapshot(current) : null;
          return designToolFailure(
            'REORDER_DESIGN_REGIONS_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: refusalCode(dispatch.error),
              error: dispatch.error.message,
              remedy: refusalRemedy(dispatch.error),
              retriable: isRetriableRefusal(dispatch.error),
              refusal: dispatch.error,
              currentVersion: current?.version ?? null,
              currentOrder: current?.regions.map((region) => region.id) ?? currentOrder,
              slots: snapshot?.slots ?? before.slots,
              gaps: snapshot?.gaps ?? before.gaps,
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
          orderBefore: currentOrder,
          order: next.regions.map((region) => region.id),
          labelsBefore: design.regions.map((region) => region.sourceSequenceName),
          labels: next.regions.map((region) => region.sourceSequenceName),
          slotsBefore: before.slots,
          slots: after.slots,
          gapsBefore: before.gaps,
          gaps: after.gaps,
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
            toolName: 'reorder_design_regions',
            effect: 'reordered_design_regions',
            designId,
            beforeVersion: previousVersion,
            afterVersion: next.version,
            changed: true,
            expected: { order: input.order },
          }),
        });
      } catch (error) {
        return designToolFailure(
          'REORDER_DESIGN_REGIONS_FAILED',
          {
            ...base,
            status: 'rejected' as const,
            code: 'EXECUTION_FAILED',
            error: `Failed to reorder design regions: ${
              error instanceof Error ? error.message : String(error)
            }`,
            remedy: 'Re-read the design with get_design before retrying.',
          },
          effects
        );
      }
    }),
});
