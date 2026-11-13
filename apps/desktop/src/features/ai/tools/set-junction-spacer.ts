   
                                                                             
                                
  
                                                              
                                                                               
                                                                           
                                                                                
                                                                          
                                                                              
                                                           
  
                                                                  
                                                     
                                                                            
                                                                           
                                                                                
                                                                             
                         
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import { IUPAC_EXPANSION } from '@waypoint/sequence-utils';
import { useDesignStore } from '../../design/public/store';
import { selectAssemblyBoundaries } from '../../design/public/assembly-boundaries';
import { computeJunctionCount } from '../../junction-workbench/public/AssemblyWorkbenchIdentity';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from '../../junction-workbench/public/AssemblyWorkbenchReducer';
import type { DesignSpacer, SequenceDesign } from '../../design/public/types';
import { createDesignMutationClaim } from './agent-mutation';
import { isGoldenGateSchemaStructureLocked } from '../../design/public/golden-gate-schema';

export const setJunctionSpacerSchema = z
  .object({
    designId: z
      .string()
      .min(1)
      .describe('Design id returned by create_design, or a waypoint://design/{id} URI.'),
    junctionIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Which junction to write. Junction i is the junction AFTER region i. Designs are ' +
          'circular, so a design with N parts has N junctions (the last one wraps). Read ' +
          'junctionCount from get_design. Provide this OR spacerId.'
      ),
    spacerId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Address an existing spacer by id instead of by junctionIndex. Resolved to its own ' +
          'junction. Refused if that junction holds more than one spacer.'
      ),
    sequence: z
      .string()
      .describe(
        'The spacer sequence, IUPAC nucleotide bases, up to 500 bp. Case is normalized to uppercase. ' +
          'Pass an empty string to REMOVE the spacer at this junction.'
      ),
    name: z.string().max(200).optional().describe('Optional label for the spacer.'),
    expectedDesignVersion: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'The design version you last read. If supplied and the design has moved on, the write ' +
          'is refused with code stale-design-version instead of overwriting. If omitted NO ' +
          'concurrency guard runs — the result reports versionGuardApplied so you can tell.'
      ),
  })
  .strict();

type SetJunctionSpacerInput = z.infer<typeof setJunctionSpacerSchema>;

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

function spacerAtJunction(design: SequenceDesign, junctionIndex: number): DesignSpacer | null {
  return design.spacers.find((spacer) => spacer.junctionIndex === junctionIndex) ?? null;
}

function projectSpacer(spacer: DesignSpacer | null) {
  if (!spacer) return null;
  return {
    id: spacer.id,
    junctionIndex: spacer.junctionIndex,
    sequence: spacer.sequence,
    name: spacer.name ?? null,
  };
}

export const setJunctionSpacerTool = resultTool({
  description:
    'Insert, replace, or clear the synthetic spacer sequence at an assembly junction. A spacer ' +
    'is extra DNA placed BETWEEN two assembled parts — a linker, a scar, or deliberate spacing. ' +
    'It becomes part of the assembled product and of the primer tails that build the junction. ' +
    'Pass an empty sequence to remove a spacer. Junction i is the junction after region i; read ' +
    'junctionCount from get_design first. After writing, call draft_design_assembly to ' +
    're-validate — no write recomputes validation on its own.',
  inputSchema: setJunctionSpacerSchema as z.ZodTypeAny,
  execute: async (input: SetJunctionSpacerInput, context?: { toolCallId?: string }) =>
    runDesignTool('SET_JUNCTION_SPACER_FAILED', async (effects) => {
      const {
        designId: rawDesignId,
        junctionIndex: requestedIndex,
        spacerId,
        sequence,
        name,
        expectedDesignVersion,
      } = input;
      const designId = normalizeDesignId(rawDesignId);

      const base = {
        designId,
        spacer: null,
        replaced: null,
        replacedSpacers: [],
        revalidationRequired: false,
        versionGuardApplied: expectedDesignVersion !== undefined,
      };

      try {
        const design = useDesignStore.getState().designs[designId];
        if (!design) {
          return designToolFailure(
            'SET_JUNCTION_SPACER_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'design-not-found',
              error: `Design not found: ${designId}`,
            },
            effects
          );
        }
        if (isGoldenGateSchemaStructureLocked(design.goldenGateSchema)) {
          return designToolFailure(
            'SET_JUNCTION_SPACER_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'SCHEMA_STRUCTURE_LOCKED',
              error:
                'This reusable Golden Gate schema fixes its junctions. Clear the schema before adding or changing spacer DNA.',
              designVersion: design.version,
            },
            effects
          );
        }

        const junctionCount = computeJunctionCount(design);
        const boundaries = selectAssemblyBoundaries(design);

                                                                   
        let junctionIndex = requestedIndex;
        if (spacerId !== undefined) {
          const target = design.spacers.find((spacer) => spacer.id === spacerId);
          if (!target) {
            return designToolFailure(
              'SET_JUNCTION_SPACER_FAILED',
              {
                ...base,
                status: 'rejected' as const,
                code: 'spacer-not-found',
                error: `Spacer not found: ${spacerId}`,
                knownSpacerIds: design.spacers.map((spacer) => spacer.id),
              },
              effects
            );
          }
          if (requestedIndex !== undefined && requestedIndex !== target.junctionIndex) {
            return designToolFailure(
              'SET_JUNCTION_SPACER_FAILED',
              {
                ...base,
                status: 'rejected' as const,
                code: 'AMBIGUOUS_TARGET',
                error:
                  `spacerId ${spacerId} is at junction ${target.junctionIndex}, but junctionIndex ` +
                  `${requestedIndex} names a different gap. Pass only one addressing mode, or make ` +
                  'them agree.',
                spacerIdTarget: target.junctionIndex,
                junctionIndexTarget: requestedIndex,
              },
              effects
            );
          }
                                                                                  
                                                                                 
                                                                  
          const boundary = boundaries.find((item) => item.junctionIndex === target.junctionIndex);
          if (boundary && boundary.duplicateSpacers.length > 0) {
            return designToolFailure(
              'SET_JUNCTION_SPACER_FAILED',
              {
                ...base,
                status: 'rejected' as const,
                code: 'AMBIGUOUS_JUNCTION',
                error:
                  `Junction ${target.junctionIndex} holds more than one spacer, so addressing by ` +
                  'spacerId is ambiguous. Address it by junctionIndex to replace them all.',
                junctionIndex: target.junctionIndex,
                spacerIds: [boundary.spacer, ...boundary.duplicateSpacers]
                  .filter((item): item is DesignSpacer => item !== null)
                  .map((item) => item.id),
              },
              effects
            );
          }
          junctionIndex = target.junctionIndex;
        }

        if (junctionIndex === undefined) {
          return designToolFailure(
            'SET_JUNCTION_SPACER_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'BAD_INPUT',
              error: 'Provide either junctionIndex or spacerId.',
              junctionCount,
              validRange: [0, Math.max(0, junctionCount - 1)] as [number, number],
            },
            effects
          );
        }

        if (junctionCount === 0 || junctionIndex > junctionCount - 1) {
          return designToolFailure(
            'SET_JUNCTION_SPACER_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'invalid-command-target',
              error:
                junctionCount === 0
                  ? 'This design has no junctions yet — add at least two regions first.'
                  : `Junction ${junctionIndex} does not exist.`,
              junctionCount,
              validRange: [0, Math.max(0, junctionCount - 1)] as [number, number],
            },
            effects
          );
        }

        const previousSpacers = design.spacers.filter(
          (spacer) => spacer.junctionIndex === junctionIndex
        );
        const previousSpacer = previousSpacers[0] ?? null;
        const previousVersion = design.version;
        const guardVersion = expectedDesignVersion ?? design.version;
                                                                                        
        const normalizedSequence = sequence
          .replace(/\s+/g, '')
          .replace(/[a-z]/g, (base) => base.toUpperCase());
        if ([...normalizedSequence].some((base) => IUPAC_EXPANSION[base] === undefined)) {
          return designToolFailure(
            'SET_JUNCTION_SPACER_FAILED',
            { ...base, status: 'rejected' as const, code: 'invalid-command-value',
              error: 'Spacer sequence must contain only IUPAC nucleotide bases.',
              designVersion: design.version, previousVersion },
            effects
          );
        }


        const result = applyAssemblyWorkbenchCommand({
          design,
          viewState: createAssemblyWorkbenchViewState(design),
          command: {
            type: 'setJunctionSpacer',
            junctionIndex,
            sequence: normalizedSequence,
            ...(name !== undefined ? { name } : {}),
            expectedDesignVersion: guardVersion,
          },
        });

        if (result.status === 'noop') {
          return toolSuccess({
            ...base,
            status: 'noop' as const,
            junctionIndex,
            junctionCount,
            spacer: projectSpacer(previousSpacer),
            replacedSpacers: [],
            previousVersion,
            designVersion: design.version,
            warnings: result.warnings,
            revalidationRequired: false,
          });
        }

        if (result.status !== 'applied') {
          const stale = result.errors?.some((error) =>
            String(error?.code ?? error).includes('stale-design-version')
          );
          return designToolFailure(
            'SET_JUNCTION_SPACER_FAILED',
            {
              ...base,
              status: result.status,
              ...(stale ? { code: 'stale-design-version', currentVersion: design.version } : {}),
              errors: result.errors,
              warnings: result.warnings,
              designVersion: design.version,
              previousVersion,
              error: result.errors?.[0]?.message ?? undefined,
            },
            effects
          );
        }

        effects.attemptedMutation();
        const committed = useDesignStore
          .getState()
          .commitWorkbenchDesign(design.id, result.nextDesign, guardVersion);

        if (!committed) {
          effects.unchanged();
                                                                                 
                                                                                  
                                                      
          const current = useDesignStore.getState().designs[designId];
          return designToolFailure(
            'SET_JUNCTION_SPACER_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'stale-design-version',
              error:
                'The design changed before this edit could be committed. Re-read it with get_design ' +
                'and retry.',
              previousVersion,
              currentVersion: current?.version ?? null,
              retriable: true,
            },
            effects
          );
        }

        effects.changed({ kind: 'design-edited', designId });
        const next = useDesignStore.getState().designs[designId] ?? result.nextDesign;
        const spacer = spacerAtJunction(next, junctionIndex);

        return toolSuccess({
          ...base,
          status: 'applied' as const,
          junctionIndex,
          junctionCount,
          spacer: projectSpacer(spacer),
          replaced: previousSpacer
            ? {
                previousSequence: previousSpacer.sequence,
                previousName: previousSpacer.name ?? null,
              }
            : null,
                                                                          
                                                                                 
                                                       
          replacedSpacers: previousSpacers.map(projectSpacer),
          previousVersion,
          designVersion: next.version,
          appliedCommands: result.appliedCommands,
          warnings: result.warnings,
                                                                            
                                                                              
          revalidationRequired: true,
          mutation: createDesignMutationClaim({
            operationId: context?.toolCallId,
            toolName: 'set_junction_spacer',
            effect: 'set_junction_spacer',
            designId,
            beforeVersion: previousVersion,
            afterVersion: next.version,
            changed: true,
            expected: {
              junctionIndex,
              spacerSequence: spacer?.sequence ?? '',
            },
          }),
        });
      } catch (error) {
        return designToolFailure(
          'SET_JUNCTION_SPACER_FAILED',
          {
            ...base,
            status: 'rejected' as const,
            code: 'EXECUTION_FAILED',
            error: `Failed to set junction spacer: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          effects
        );
      }
    }),
});
