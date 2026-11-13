   
                                                                              
                                          
  
                                                                  
                                                                                 
                                                                                              
                                                                               
                                                                               
                                                                               
                                                          
  
                                                                          
                                                                            
                                                                           
                                                                                
                                                       
  
                                                                              
                                                                                
                                                                                
                                                                               
                                                                               
                                            
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import { primerPbsLengthRange } from '../../design/public/algorithms/draft-assembly';
import { getEffectiveDesignRegions } from '../../design/public/restriction-digest';
import { useDesignStore } from '../../design/public/store';
import {
  ensureAssemblyWorkbenchIdentity,
  getPrimerIdentity,
} from '../../junction-workbench/public/AssemblyWorkbenchIdentity';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from '../../junction-workbench/public/AssemblyWorkbenchReducer';
import type { DesignPrimer, SequenceDesign } from '../../design/public/types';
import { createDesignMutationClaim } from './agent-mutation';

export const setPrimerPbsLengthSchema = z
  .object({
    designId: z
      .string()
      .min(1)
      .describe('Design id returned by create_design, or a waypoint://design/{id} URI.'),
    primerId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Stable id of the primer to edit, as returned by get_design / a previous call. ' +
          'Provide this OR both fragmentIndex and direction.'
      ),
    fragmentIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Zero-based index of the part (region) this primer amplifies, in the order the parts ' +
          'were added to the design. Must be paired with direction. Ignored if primerId is given ' +
          'and both agree.'
      ),
    direction: z
      .enum(['forward', 'reverse'])
      .optional()
      .describe(
        "Which primer of the part's PCR pair: 'forward' anneals to the top strand at the part's " +
          "5' end, 'reverse' anneals to the bottom strand at its 3' end. Must be paired with " +
          'fragmentIndex.'
      ),
                                                                               
                                                                                
                                                               
    length: z
      .number()
      .int()
      .describe(
        "New primer-binding-site length in bases (bp), bounded by the template the primer's " +
          'part provides; a refusal reports the allowed range as validLengthRange. This is the ' +
          'annealing length only — the 5′ tail is not counted and is not changed.'
      ),
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

type SetPrimerPbsLengthInput = z.infer<typeof setPrimerPbsLengthSchema>;

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

function pbsLengthOf(primer: DesignPrimer): number {
  return primer.pbs.end - primer.pbs.start;
}

                                                                                 
function primerDirectory(design: SequenceDesign) {
  return design.designPrimers.flatMap((pair) =>
    [pair.forward, pair.reverse].map((primer) => ({
      primerId: primer.id,
      name: primer.name,
      fragmentIndex: primer.fragmentIndex,
      direction: primer.direction,
      pbsLength: pbsLengthOf(primer),
    }))
  );
}

function findPrimerById(design: SequenceDesign, primerId: string): DesignPrimer | null {
  for (const pair of design.designPrimers) {
    if (pair.forward.id === primerId) return pair.forward;
    if (pair.reverse.id === primerId) return pair.reverse;
  }
  return null;
}

function projectPrimer(primer: DesignPrimer | null) {
  if (!primer) return null;
  return {
    id: primer.id,
    name: primer.name,
    fragmentIndex: primer.fragmentIndex,
    direction: primer.direction,
    junctionIndex: primer.junctionIndex,
    pbsLength: pbsLengthOf(primer),
    pbsSequence: primer.pbs.sequence,
    sequence: primer.sequence,
    tm: primer.tm ?? null,
  };
}

export const setPrimerPbsLengthTool = resultTool({
  description:
    "Set the length of an assembly primer's PBS (primer binding site) — the 3' portion that " +
    'actually anneals to the template during PCR. Lengthening it raises the primer Tm and ' +
    'specificity; shortening it lowers both. Length is in bases (bp): at most the template ' +
    "the primer's part provides, and at least 10 (or the whole template for a shorter part). " +
    "A refusal for a resolved primer reports that primer's range as validLengthRange. " +
    "This is NOT the primer's 5′ tail/overhang (the homology " +
    'arm or Golden Gate prefix that joins two parts) — that is a separate tool. Changing the ' +
    'PBS rewrites the primer sequence and its Tm; it does not move the junction/crossover and ' +
    'does not change the assembled product. Works in every assembly method (gibson, nebuilder, ' +
    'goldengate). The design must already be drafted — call draft_design_assembly first or ' +
    'there are no primers to edit. Address a primer by primerId, or by fragmentIndex (0-based ' +
    'part index) plus direction. After writing, call draft_design_assembly to re-validate — no ' +
    'write recomputes validation on its own.',
  inputSchema: setPrimerPbsLengthSchema as z.ZodTypeAny,
  execute: async (input: SetPrimerPbsLengthInput, context?: { toolCallId?: string }) =>
    runDesignTool('SET_PRIMER_PBS_LENGTH_FAILED', async (effects) => {
      const {
        designId: rawDesignId,
        primerId,
        fragmentIndex,
        direction,
        length,
        expectedDesignVersion,
      } = input;
      const designId = normalizeDesignId(rawDesignId);

      const base = {
        designId,
        primer: null,
        requestedLength: length,
        revalidationRequired: false,
        versionGuardApplied: expectedDesignVersion !== undefined,
      };

      try {
        const stored = useDesignStore.getState().designs[designId];
        if (!stored) {
          return designToolFailure(
            'SET_PRIMER_PBS_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'design-not-found',
              error: `Design not found: ${designId}`,
              knownDesignIds: Object.keys(useDesignStore.getState().designs),
            },
            effects
          );
        }

                                                                                
                                                                                   
                                                                                
                                                                      
        const design = ensureAssemblyWorkbenchIdentity(stored);
        const fragmentCount = design.regions.length;
        const validFragmentRange = [0, Math.max(0, fragmentCount - 1)] as [number, number];

        if (design.designPrimers.length === 0) {
          return designToolFailure(
            'SET_PRIMER_PBS_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'primers-not-drafted',
              error:
                'This design has no primers yet, so there is no primer binding site to resize. Call ' +
                'draft_design_assembly first (adding or removing a part also clears the primers).',
              fragmentCount,
              assemblyState: design.assemblyState,
            },
            effects
          );
        }

        const usesFragmentAddressing = fragmentIndex !== undefined || direction !== undefined;
        if (usesFragmentAddressing && (fragmentIndex === undefined || direction === undefined)) {
          return designToolFailure(
            'SET_PRIMER_PBS_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'BAD_INPUT',
              error:
                'Addressing a primer by part requires BOTH fragmentIndex and direction ' +
                `(${fragmentIndex === undefined ? 'fragmentIndex' : 'direction'} was missing). ` +
                'Alternatively pass primerId.',
              fragmentCount,
              validFragmentRange,
              knownPrimers: primerDirectory(design),
            },
            effects
          );
        }

        if (primerId === undefined && !usesFragmentAddressing) {
          return designToolFailure(
            'SET_PRIMER_PBS_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'BAD_INPUT',
              error: 'Provide either primerId, or both fragmentIndex and direction.',
              fragmentCount,
              validFragmentRange,
              knownPrimers: primerDirectory(design),
            },
            effects
          );
        }

        if (fragmentIndex !== undefined && fragmentIndex > fragmentCount - 1) {
          return designToolFailure(
            'SET_PRIMER_PBS_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'invalid-command-target',
              error: `Fragment ${fragmentIndex} does not exist; this design has ${fragmentCount} part${
                fragmentCount === 1 ? '' : 's'
              }.`,
              fragmentCount,
              validFragmentRange,
              knownPrimers: primerDirectory(design),
            },
            effects
          );
        }

        const byId = primerId !== undefined ? getPrimerIdentity(design, { primerId }) : null;
        if (primerId !== undefined && !byId) {
          return designToolFailure(
            'SET_PRIMER_PBS_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'primer-not-found',
              error: `Primer not found: ${primerId}`,
              fragmentCount,
              knownPrimers: primerDirectory(design),
            },
            effects
          );
        }

        const byFragment =
          fragmentIndex !== undefined && direction !== undefined
            ? getPrimerIdentity(design, { fragmentIndex, direction })
            : null;
        if (fragmentIndex !== undefined && direction !== undefined && !byFragment) {
          return designToolFailure(
            'SET_PRIMER_PBS_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'invalid-command-target',
              error: `No ${direction} primer exists for fragment ${fragmentIndex}.`,
              fragmentCount,
              validFragmentRange,
              knownPrimers: primerDirectory(design),
            },
            effects
          );
        }

                                                                              
                                                                                  
                                                               
        if (byId && byFragment && byId.id !== byFragment.id) {
          return designToolFailure(
            'SET_PRIMER_PBS_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'AMBIGUOUS_TARGET',
              error:
                'primerId and fragmentIndex+direction point at two different primers. Pass only one ' +
                'addressing mode.',
              primerIdTarget: byId.id,
              fragmentTarget: byFragment.id,
              knownPrimers: primerDirectory(design),
            },
            effects
          );
        }

        const identity = byId ?? byFragment;
        if (!identity) {
          return designToolFailure(
            'SET_PRIMER_PBS_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'invalid-command-target',
              error: 'The primer target does not exist.',
              fragmentCount,
              validFragmentRange,
              knownPrimers: primerDirectory(design),
            },
            effects
          );
        }

        const previousPrimer = findPrimerById(design, identity.id);
        if (!previousPrimer) {
          return designToolFailure(
            'SET_PRIMER_PBS_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'primers-not-drafted',
              error:
                `Primer ${identity.id} has an identity but no drafted primer behind it. Call ` +
                'draft_design_assembly to (re)build the primers, then retry.',
              fragmentCount,
              knownPrimers: primerDirectory(design),
            },
            effects
          );
        }

                                                                                 
                                                                         
        const range = primerPbsLengthRange(
          previousPrimer,
          getEffectiveDesignRegions(design),
          design.spacers ?? []
        );
                                                                                  
                                                   
        const hasTemplate = range.max >= 1;
        const resolved = {
          ...base,
          ...(hasTemplate ? { validLengthRange: [range.min, range.max] as [number, number] } : {}),
        };

        const previousLength = pbsLengthOf(previousPrimer);
        const previousVersion = stored.version;
        const guardVersion = expectedDesignVersion ?? stored.version;

                                                                                
                                                            
        if (!hasTemplate && guardVersion === stored.version) {
          return designToolFailure(
            'SET_PRIMER_PBS_LENGTH_FAILED',
            {
              ...resolved,
              status: 'rejected' as const,
              code: 'primer-template-unavailable',
              error:
                `Primer ${identity.id} has no template left to anneal to, so its binding site ` +
                'cannot be resized. Call draft_design_assembly to rebuild the primers, then retry.',
              fragmentCount,
            },
            effects
          );
        }

        const result = applyAssemblyWorkbenchCommand({
          design: stored,
          viewState: createAssemblyWorkbenchViewState(stored),
          command: {
            type: 'setPrimerPbsLength',
            primerId: identity.id,
            length,
            expectedDesignVersion: guardVersion,
          },
        });

        if (result.status !== 'applied') {
          const stale = result.errors?.some((error) =>
            String(error?.code ?? error).includes('stale-design-version')
          );
          return designToolFailure(
            'SET_PRIMER_PBS_LENGTH_FAILED',
            {
              ...resolved,
              status: result.status,
              code: stale ? 'stale-design-version' : result.errors?.[0]?.code,
              ...(stale ? { currentVersion: stored.version } : {}),
              errors: result.errors,
              warnings: result.warnings,
              designVersion: stored.version,
              previousVersion,
              error: result.errors?.[0]?.message ?? undefined,
            },
            effects
          );
        }

        effects.attemptedMutation();
        const committed = useDesignStore
          .getState()
          .commitWorkbenchDesign(designId, result.nextDesign, guardVersion);

        if (!committed) {
          effects.unchanged();
                                                                                 
                                                                                  
                                                      
          const current = useDesignStore.getState().designs[designId];
          return designToolFailure(
            'SET_PRIMER_PBS_LENGTH_FAILED',
            {
              ...resolved,
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
        const nextPrimer = findPrimerById(next, identity.id);
        const appliedLength = nextPrimer ? pbsLengthOf(nextPrimer) : previousLength;

        return toolSuccess({
          ...resolved,
          status: 'applied' as const,
          primer: projectPrimer(nextPrimer),
          previousPbsLength: previousLength,
          appliedLength,
          changed: appliedLength !== previousLength,
          fragmentCount,
          previousVersion,
          designVersion: next.version,
          appliedCommands: result.appliedCommands,
          warnings: result.warnings,
                                                                            
                                                                              
          revalidationRequired: true,
          mutation: createDesignMutationClaim({
            operationId: context?.toolCallId,
            toolName: 'set_primer_pbs_length',
            effect: 'set_primer_pbs_length',
            designId,
            beforeVersion: previousVersion,
            afterVersion: next.version,
            changed: next.version !== previousVersion,
            expected: {
              primerId: identity.id,
              fragmentIndex: previousPrimer.fragmentIndex,
              direction: previousPrimer.direction,
              pbsLength: appliedLength,
            },
          }),
        });
      } catch (error) {
        return designToolFailure(
          'SET_PRIMER_PBS_LENGTH_FAILED',
          {
            ...base,
            status: 'rejected' as const,
            code: 'EXECUTION_FAILED',
            error: `Failed to set primer PBS length: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          effects
        );
      }
    }),
});
