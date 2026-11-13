   
                                                                            
                                                            
  
                                                                           
                                                                                
                                                                            
                                                                               
                                                                          
                                                                  
                                                                              
                                                                                
                                                                               
                                                                           
  
                                                                  
                                                                         
                                                                             
                                                                       
                                                                             
                                                                              
                                                                              
                                         
  
                                                                        
                                                                         
                                                                               
                                                                              
                                                              
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import { useDesignStore } from '../../design/public/store';
import { ASSEMBLY_WORKBENCH_CAPABILITIES } from '../../junction-workbench/public/AssemblyWorkbenchContract';
import { ensureAssemblyWorkbenchIdentity } from '../../junction-workbench/public/AssemblyWorkbenchIdentity';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from '../../junction-workbench/public/AssemblyWorkbenchReducer';
import type { AssemblyMethod, DesignPrimer, SequenceDesign } from '../../design/public/types';
import { designResourceUri } from './agent-mutation';

   
                                                                               
                                                                               
                                                                             
                                                                            
                                               
   
const OVERHANG_MIN_BP = 0;
const OVERHANG_MAX_BP = 60;

   
                                                                             
                                                                             
   
const SUPPORTED_ASSEMBLY_METHODS: AssemblyMethod[] = (() => {
  const capability = ASSEMBLY_WORKBENCH_CAPABILITIES.find(
    (item) => item.command === 'setPrimerOverhangLength'
  );
  if (!capability || capability.supportedModes === 'all') return [];
  return [...capability.supportedModes];
})();

export const setPrimerOverhangLengthSchema = z
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
        'Address the primer directly by its stable id. Ids are returned by this tool and by the ' +
          'assembly workbench. Provide this OR both fragmentIndex and direction.'
      ),
    fragmentIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Which part the primer amplifies, 0-based, in the order get_design lists regions. Must ' +
          'be paired with direction.'
      ),
    direction: z
      .enum(['forward', 'reverse'])
      .optional()
      .describe(
        'Which primer of the fragment pair. The forward primer carries the tail for the junction ' +
          'BEFORE the part; the reverse primer carries the tail for the junction AFTER it. Must ' +
          'be paired with fragmentIndex.'
      ),
    length: z
      .number()
      .int()
      .describe(
        `New FULL synthesized 5' tail length in base pairs, ${OVERHANG_MIN_BP}..${OVERHANG_MAX_BP}. ` +
          'This includes any spacer cargo carried in the tail. 0 removes the tail entirely, ' +
          'leaving a plain PCR primer with no homology arm.'
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

type SetPrimerOverhangLengthInput = z.infer<typeof setPrimerOverhangLengthSchema>;

type PrimerSlot = {
  primer: DesignPrimer;
  fragmentIndex: number;
  direction: 'forward' | 'reverse';
};

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

function primerSlots(design: SequenceDesign): PrimerSlot[] {
  return design.designPrimers.flatMap((pair) => [
    { primer: pair.forward, fragmentIndex: pair.fragmentIndex, direction: 'forward' as const },
    { primer: pair.reverse, fragmentIndex: pair.fragmentIndex, direction: 'reverse' as const },
  ]);
}

                                                              
function tailLengthOf(primer: DesignPrimer): number {
  return primer.overhang.tailLength ?? primer.overhang.sequence.length;
}

function projectPrimer(slot: PrimerSlot) {
  const primer = slot.primer;
  return {
    id: primer.id,
    name: primer.name,
    direction: slot.direction,
    fragmentIndex: slot.fragmentIndex,
    junctionIndex: primer.junctionIndex,
                                                                              
                                                                       
                                                                         
    overhangLength: tailLengthOf(primer),
    annealingLength: primer.overhang.length,
    overhangSequence: primer.overhang.sequence,
    pbsLength: primer.pbs.sequence.length,
    pbsSequence: primer.pbs.sequence,
    sequence: primer.sequence,
    tm: primer.tm ?? null,
  };
}

                                                         
function knownPrimerTargets(design: SequenceDesign) {
  return primerSlots(design).map((slot) => ({
    primerId: slot.primer.id,
    fragmentIndex: slot.fragmentIndex,
    direction: slot.direction,
    junctionIndex: slot.primer.junctionIndex,
    overhangLength: tailLengthOf(slot.primer),
  }));
}

function projectHomology(design: SequenceDesign, junctionIndex: number) {
  const homology = design.homologyRegions.find((item) => item.junctionIndex === junctionIndex);
  if (!homology) return null;
  return {
    junctionIndex,
    onLeft: homology.encoding.onLeft,
    onRight: homology.encoding.onRight,
    tmEstimate: homology.metadata?.tmEstimate ?? null,
    gcContent: homology.metadata?.gcContent ?? null,
  };
}

function formatTm(tm: number | null): string {
  return typeof tm === 'number' ? `${tm.toFixed(1)}C` : 'unknown';
}

export const setPrimerOverhangLengthTool = resultTool({
  description:
    "Set the length of an assembly primer's 5' overhang (its tail) on a Gibson or NEBuilder " +
    'design. The overhang is the non-annealing part of the primer, added by PCR, that becomes ' +
    'the homology arm bridging this part with its neighbour in the assembly reaction. ' +
    'Lengthening it increases the overlap shared with the neighbouring part (and raises the ' +
    'overlap Tm); shortening it reduces the overlap. Length is in base pairs and sets the FULL ' +
    'synthesized tail, spacer cargo included. Gibson and NEBuilder ONLY — a Golden Gate junction ' +
    'uses a fixed, enzyme-determined 4 bp sticky end that is repositioned, never resized. A tail ' +
    "longer than the natural homology arm eats into this primer's own binding site, shortening " +
    'the annealing region and lowering its Tm; the result reports that. The design must already ' +
    'be drafted (draft_design_assembly), and after writing you must call draft_design_assembly ' +
    'again to re-validate — no write recomputes validation on its own.',
  inputSchema: setPrimerOverhangLengthSchema as z.ZodTypeAny,
  execute: async (input: SetPrimerOverhangLengthInput, context?: { toolCallId?: string }) =>
    runDesignTool('SET_PRIMER_OVERHANG_LENGTH_FAILED', async (effects) => {
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
        partnerPrimer: null,
        revalidationRequired: false,
        versionGuardApplied: expectedDesignVersion !== undefined,
      };

      try {
        const stored = useDesignStore.getState().designs[designId];
        if (!stored) {
          return designToolFailure(
            'SET_PRIMER_OVERHANG_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'design-not-found',
              error: `Design not found: ${designId}`,
            },
            effects
          );
        }

                                                                                 
                                                                              
                                                                                
                                              
        const design = ensureAssemblyWorkbenchIdentity(stored);

        if (
          SUPPORTED_ASSEMBLY_METHODS.length > 0 &&
          !SUPPORTED_ASSEMBLY_METHODS.includes(design.assemblyMethod)
        ) {
          return designToolFailure(
            'SET_PRIMER_OVERHANG_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'unsupported-mode-command',
              error:
                `This design uses the ${design.assemblyMethod} assembly method. Primer overhang ` +
                `length is only editable on: ${SUPPORTED_ASSEMBLY_METHODS.join(', ')}. A Golden Gate ` +
                "junction's 4 bp sticky end is determined by the type IIS enzyme and is repositioned " +
                '(junction offset), never resized, so there is no tail length to set.',
              currentAssemblyMethod: design.assemblyMethod,
              supportedAssemblyMethods: SUPPORTED_ASSEMBLY_METHODS,
            },
            effects
          );
        }

        const slots = primerSlots(design);
        if (slots.length === 0) {
          return designToolFailure(
            'SET_PRIMER_OVERHANG_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'no-drafted-primers',
              error:
                'This design has no drafted primers, so there is no overhang to size. Call ' +
                'draft_design_assembly first, then retry.',
              regionCount: design.regions.length,
              assemblyState: design.assemblyState,
            },
            effects
          );
        }

        const hasFragmentIndex = fragmentIndex !== undefined;
        const hasDirection = direction !== undefined;
        if (hasFragmentIndex !== hasDirection) {
          const half = hasFragmentIndex
            ? 'fragmentIndex without direction'
            : 'direction without fragmentIndex';
          return designToolFailure(
            'SET_PRIMER_OVERHANG_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'BAD_INPUT',
              error: `Got ${half}. Address a primer by primerId, or by BOTH fragmentIndex and direction.`,
              fragmentCount: design.regions.length,
              validDirections: ['forward', 'reverse'],
              knownPrimers: knownPrimerTargets(design),
            },
            effects
          );
        }

        let target: PrimerSlot | undefined;
        if (primerId !== undefined) {
          target = slots.find((slot) => slot.primer.id === primerId);
          if (!target) {
            return designToolFailure(
              'SET_PRIMER_OVERHANG_LENGTH_FAILED',
              {
                ...base,
                status: 'rejected' as const,
                code: 'primer-not-found',
                error: `Primer not found: ${primerId}`,
                knownPrimers: knownPrimerTargets(design),
              },
              effects
            );
          }
          if (fragmentIndex !== undefined && direction !== undefined) {
            const addressedByFragment = slots.find(
              (slot) => slot.fragmentIndex === fragmentIndex && slot.direction === direction
            );
            if (!addressedByFragment) {
              return designToolFailure(
                'SET_PRIMER_OVERHANG_LENGTH_FAILED',
                {
                  ...base,
                  status: 'rejected' as const,
                  code: 'primer-not-found',
                  error: `Fragment ${fragmentIndex} has no drafted ${direction} primer.`,
                  knownPrimers: knownPrimerTargets(design),
                },
                effects
              );
            }
            if (addressedByFragment.primer.id !== target.primer.id) {
              return designToolFailure(
                'SET_PRIMER_OVERHANG_LENGTH_FAILED',
                {
                  ...base,
                  status: 'rejected' as const,
                  code: 'AMBIGUOUS_TARGET',
                  error:
                    'primerId and fragmentIndex+direction point at two different primers. Pass only ' +
                    'one addressing mode, or make them agree.',
                  primerIdTarget: target.primer.id,
                  fragmentTarget: addressedByFragment.primer.id,
                  knownPrimers: knownPrimerTargets(design),
                },
                effects
              );
            }
          }
        } else if (fragmentIndex !== undefined && direction !== undefined) {
          const fragmentCount = design.regions.length;
          if (fragmentIndex > fragmentCount - 1) {
            return designToolFailure(
              'SET_PRIMER_OVERHANG_LENGTH_FAILED',
              {
                ...base,
                status: 'rejected' as const,
                code: 'invalid-command-target',
                error: `Fragment ${fragmentIndex} does not exist in this design.`,
                fragmentCount,
                validFragmentRange: [0, Math.max(0, fragmentCount - 1)] as [number, number],
                knownPrimers: knownPrimerTargets(design),
              },
              effects
            );
          }
          target = slots.find(
            (slot) => slot.fragmentIndex === fragmentIndex && slot.direction === direction
          );
          if (!target) {
            return designToolFailure(
              'SET_PRIMER_OVERHANG_LENGTH_FAILED',
              {
                ...base,
                status: 'rejected' as const,
                code: 'primer-not-found',
                error: `Fragment ${fragmentIndex} has no drafted ${direction} primer.`,
                fragmentCount,
                knownPrimers: knownPrimerTargets(design),
              },
              effects
            );
          }
        } else {
          return designToolFailure(
            'SET_PRIMER_OVERHANG_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'BAD_INPUT',
              error: 'Provide either primerId, or BOTH fragmentIndex and direction.',
              fragmentCount: design.regions.length,
              validDirections: ['forward', 'reverse'],
              knownPrimers: knownPrimerTargets(design),
            },
            effects
          );
        }

        const previousOverhangLength = tailLengthOf(target.primer);

        if (length < OVERHANG_MIN_BP || length > OVERHANG_MAX_BP) {
          return designToolFailure(
            'SET_PRIMER_OVERHANG_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'invalid-command-value',
              error: `Primer overhang length must be ${OVERHANG_MIN_BP}..${OVERHANG_MAX_BP} bp; got ${length}.`,
              validRange: [OVERHANG_MIN_BP, OVERHANG_MAX_BP] as [number, number],
              currentOverhangLength: previousOverhangLength,
              primerId: target.primer.id,
            },
            effects
          );
        }

        if (target.primer.junctionIndex === null) {
          return designToolFailure(
            'SET_PRIMER_OVERHANG_LENGTH_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'invalid-command-target',
              error:
                `The ${target.direction} primer of fragment ${target.fragmentIndex} sits at an outer ` +
                'end of a linear design, so it has no assembly junction and no homology tail to size.',
              primerId: target.primer.id,
              knownPrimers: knownPrimerTargets(design).filter(
                (item) => item.junctionIndex !== null
              ),
            },
            effects
          );
        }

        const junctionIndex = target.primer.junctionIndex;
        const previousHomology = projectHomology(design, junctionIndex);
        const previousVersion = design.version;
        const guardVersion = expectedDesignVersion ?? design.version;

        const result = applyAssemblyWorkbenchCommand({
          design,
          viewState: createAssemblyWorkbenchViewState(design),
          command: {
            type: 'setPrimerOverhangLength',
                                                                                 
                                                                                  
                                                          
            primerId: target.primer.id,
            length,
            expectedDesignVersion: guardVersion,
          },
        });

        if (result.status !== 'applied') {
          const stale = result.errors?.some((error) =>
            String(error?.code ?? error).includes('stale-design-version')
          );
          return designToolFailure(
            'SET_PRIMER_OVERHANG_LENGTH_FAILED',
            {
              ...base,
              status: result.status,
              ...(stale
                ? { code: 'stale-design-version', currentVersion: design.version, retriable: true }
                : { code: result.errors?.[0]?.code ?? 'rejected' }),
              error: result.errors?.[0]?.message ?? undefined,
              errors: result.errors,
              warnings: result.warnings,
              designVersion: design.version,
              previousVersion,
                                                                                    
                                                                                   
                                                     
              validRange: [OVERHANG_MIN_BP, OVERHANG_MAX_BP] as [number, number],
              currentOverhangLength: previousOverhangLength,
              currentPbsLength: target.primer.pbs.sequence.length,
              primerId: target.primer.id,
              junctionIndex,
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
            'SET_PRIMER_OVERHANG_LENGTH_FAILED',
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
        const nextSlots = primerSlots(next);
        const nextTarget = nextSlots.find((slot) => slot.primer.id === target.primer.id);
        const nextPartner = nextSlots.find(
          (slot) =>
            slot.primer.id !== target.primer.id && slot.primer.junctionIndex === junctionIndex
        );

        const warnings: Array<{ code: string; message: string }> = (result.warnings ?? []).map(
          (warning) => ({ code: warning.code, message: warning.message })
        );

        const appliedLength = nextTarget ? tailLengthOf(nextTarget.primer) : previousOverhangLength;
        if (appliedLength !== length) {
          warnings.push({
            code: 'tail-length-adjusted',
            message:
              `Requested a ${length} bp tail; the design now carries ${appliedLength} bp. The ` +
              'reducer re-derives the tail from the junction homology, so the applied value can ' +
              'differ. Verify before ordering.',
          });
        }

        const previousPbsLength = target.primer.pbs.sequence.length;
        const nextPbsLength = nextTarget?.primer.pbs.sequence.length ?? previousPbsLength;
        if (nextPbsLength < previousPbsLength) {
          warnings.push({
            code: 'tail-consumes-pbs',
            message:
              `The tail now extends ${previousPbsLength - nextPbsLength} bp into this primer's own ` +
              `binding site: PBS ${previousPbsLength} -> ${nextPbsLength} bp, Tm ` +
              `${formatTm(target.primer.tm ?? null)} -> ${formatTm(nextTarget?.primer.tm ?? null)}. ` +
              'A shorter binding site anneals less strongly — check the Tm before ordering.',
          });
        }

        return toolSuccess({
          ...base,
          status: 'applied' as const,
          junctionIndex,
          requestedLength: length,
          previousOverhangLength,
          primer: nextTarget ? projectPrimer(nextTarget) : null,
                                                                                 
                               
          partnerPrimer: nextPartner ? projectPrimer(nextPartner) : null,
          homology: projectHomology(next, junctionIndex),
          previousHomology,
          previousVersion,
          designVersion: next.version,
          appliedCommands: result.appliedCommands,
          warnings,
                                                                            
                                                                              
          revalidationRequired: true,
                                                                                   
                                                                
                                                                                  
                                                                                 
                                                                                  
                                        
          mutation: {
            operationId: context?.toolCallId || `renderer-set_primer_overhang_length-${designId}`,
            toolName: 'set_primer_overhang_length',
            effect: 'set_primer_overhang_length',
            target: { type: 'design', id: designId },
            resourceUri: designResourceUri(designId),
            beforeVersion: previousVersion,
            afterVersion: next.version,
            changed: next.version !== previousVersion,
            expected: {
              primerId: target.primer.id,
              junctionIndex,
              overhangLength: appliedLength,
            },
          },
        });
      } catch (error) {
        return designToolFailure(
          'SET_PRIMER_OVERHANG_LENGTH_FAILED',
          {
            ...base,
            status: 'rejected' as const,
            code: 'EXECUTION_FAILED',
            error: `Failed to set primer overhang length: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          effects
        );
      }
    }),
});
