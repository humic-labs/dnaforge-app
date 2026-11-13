   
                                                                          
                           
  
                                                                           
                                                               
                                                                               
                                                                            
                                                                         
                                                                                
                                                                                
                                                                               
  
                                                                
                                                                                
                                                                                
                                                                             
                                                                                 
                                                                                   
                                                                             
                                                     
  
                                                                           
                                                                               
                                                                            
                                                                 
  
                                                                                 
                                                                                  
                                                         
                                                                               
                                                                               
                                                               
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import { useDesignStore } from '../../design/public/store';
import {
  NEB_TM_OPTIONS,
  resolveTmModel,
  type NebPolymeraseFamily,
  type NebTmOption,
  type TmModel,
} from '../../design/public/algorithms/tm-model';
import { recomputeDesignPrimerTms } from '../../design/public/algorithms/recompute-design-primer-tms';
import type { SequenceDesign } from '../../design/public/types';
import { isPcrTemplateRegion } from '../../design/public/restriction-digest';
import { createAppTmCalculator } from '../../junction-workbench/public/settings';
import { createDesignMutationClaim } from './agent-mutation';

   
                                                                                 
                                                                                 
                                                                            
   
const POLYMERASE_FAMILIES = [
  'q5',
  'phusion',
  'onetaq',
  'taq',
  'longamp',
] as const satisfies readonly NebPolymeraseFamily[];

   
                                                                               
                                                                                
                                           
   
const PRODCODES = NEB_TM_OPTIONS.map((option) => option.prodcode) as [string, ...string[]];

   
                                                                              
                                                                               
                                                                                    
                                                 
   
function firstOptionForFamily(family: NebPolymeraseFamily): NebTmOption | undefined {
  return NEB_TM_OPTIONS.find((option) => option.family === family);
}

function optionByProdcode(prodcode: string): NebTmOption | undefined {
  return NEB_TM_OPTIONS.find((option) => option.prodcode === prodcode);
}

function prodcodesInFamily(family: NebPolymeraseFamily): string[] {
  return NEB_TM_OPTIONS.filter((option) => option.family === family).map(
    (option) => option.prodcode
  );
}

const FAMILY_SUMMARY = POLYMERASE_FAMILIES.map((family) => {
  const option = firstOptionForFamily(family);
  return `${family} -> ${option?.prodcode ?? 'n/a'} (${option?.label ?? family})`;
}).join('; ');

const PRODCODE_SUMMARY = NEB_TM_OPTIONS.map(
  (option) => `${option.prodcode} = ${option.label}`
).join('; ');

export const setPcrPolymeraseSchema = z
  .object({
    designId: z
      .string()
      .min(1)
      .describe('Design id returned by create_design, or a waypoint://design/{id} URI.'),
    polymerase: z
      .enum(POLYMERASE_FAMILIES)
      .optional()
      .describe(
        'Polymerase family, when the exact buffer does not matter. Resolves to that ' +
          `family's standard product: ${FAMILY_SUMMARY}. The result reports which ` +
          'product it resolved to and what else that family offers, so a GC-buffer ' +
          'variant is one follow-up call away. Provide this OR prodcode OR clear.'
      ),
    prodcode: z
      .enum(PRODCODES)
      .optional()
      .describe(
        'Exact NEB product code, when the buffer matters (GC buffer and Hot Start ' +
          `variants have their own Tm behavior): ${PRODCODE_SUMMARY}. Provide this OR ` +
          'polymerase OR clear. If you pass both prodcode and polymerase they must agree.'
      ),
    clear: z
      .boolean()
      .optional()
      .describe(
        'Pass true to remove the design-level polymerase, so primer Tm falls back to ' +
          'the app-wide setting (see get_primer_tm_config). Cannot be combined with ' +
          'polymerase or prodcode.'
      ),
    expectedDesignVersion: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'The design version you last read. If supplied and the design has moved on, the ' +
          'write is refused with code stale-design-version instead of overwriting. If ' +
          'omitted NO concurrency guard runs — the result reports versionGuardApplied so ' +
          'you can tell.'
      ),
  })
  .strict();

type SetPcrPolymeraseInput = z.infer<typeof setPcrPolymeraseSchema>;

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

type PolymeraseProjection = {
  prodcode: string;
  family: NebPolymeraseFamily | null;
  label: string | null;
};

   
                                                                           
                                                                                 
                                                                              
   
function projectProdcode(prodcode: string | null): PolymeraseProjection | null {
  if (!prodcode) return null;
  const option = optionByProdcode(prodcode);
  return {
    prodcode,
    family: option?.family ?? null,
    label: option?.label ?? null,
  };
}

   
                                                                                
                                                                               
                                                                                  
                                                                                  
                                                
   
function pcrPartCount(design: SequenceDesign): number {
  return design.regions.filter(isPcrTemplateRegion).length;
}

export const setPcrPolymeraseTool = resultTool({
  description:
    'Set which PCR polymerase a specific design is built with (NEB Q5, Phusion, OneTaq, Taq, ' +
    'LongAmp). This is per-design and outranks the app-wide Tm setting for that design, ' +
    'because the enzyme on the bench for this construct is more specific than a global ' +
    "preference. It selects the melting-temperature model used when drafting that design's " +
    'assembly primers: call draft_design_assembly afterwards, then read tmResolution to see ' +
    "which model applied and why, and each primer's tmProvenance to see whether its Tm was " +
    'verified against the vendor service or is still a local estimate (verification happens in ' +
    'the background and degrades to the local value when offline). Pass a family ' +
    '(polymerase: "q5") or an exact product code (prodcode: "phusion-1" for GC buffer), or ' +
    'clear: true to fall back to the app default.',
  inputSchema: setPcrPolymeraseSchema as z.ZodTypeAny,
  execute: async (input: SetPcrPolymeraseInput, context?: { toolCallId?: string }) =>
    runDesignTool('SET_PCR_POLYMERASE_FAILED', async (effects) => {
      const {
        designId: rawDesignId,
        polymerase: requestedFamily,
        prodcode: requestedProdcode,
        clear,
        expectedDesignVersion,
      } = input;
      const designId = normalizeDesignId(rawDesignId);

      const base = {
        designId,
        polymerase: null as PolymeraseProjection | null,
        previousPolymerase: null as PolymeraseProjection | null,
        tmModel: null as TmModel | null,
        revalidationRequired: false,
        versionGuardApplied: expectedDesignVersion !== undefined,
      };

      try {
        const designs = useDesignStore.getState().designs;
        const design = designs[designId] as SequenceDesign | undefined;
        if (!design) {
          return designToolFailure(
            'SET_PCR_POLYMERASE_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'design-not-found',
              error: `Design not found: ${designId}`,
                                                                                       
                                                    
              knownDesignIds: Object.keys(designs),
            },
            effects
          );
        }

        const wantsClear = clear === true;
        const namedAnEnzyme = requestedFamily !== undefined || requestedProdcode !== undefined;

        if (wantsClear && namedAnEnzyme) {
          return designToolFailure(
            'SET_PCR_POLYMERASE_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'BAD_INPUT',
              error:
                'clear:true cannot be combined with polymerase or prodcode — it is ambiguous ' +
                'whether you meant to set the enzyme or remove it. Send one or the other.',
              requested: {
                clear: true,
                polymerase: requestedFamily ?? null,
                prodcode: requestedProdcode ?? null,
              },
            },
            effects
          );
        }

        if (!wantsClear && !namedAnEnzyme) {
          return designToolFailure(
            'SET_PCR_POLYMERASE_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'BAD_INPUT',
              error: 'Provide polymerase (a family), prodcode (an exact product), or clear:true.',
              supportedFamilies: [...POLYMERASE_FAMILIES],
              supportedProdcodes: [...PRODCODES],
              currentPolymerase: projectProdcode(design.pcrPolymerase ?? null),
            },
            effects
          );
        }

        let target: NebTmOption | null = null;
        let resolvedFrom: 'family' | 'prodcode' | 'cleared' = 'cleared';

        if (requestedProdcode !== undefined) {
          const option = optionByProdcode(requestedProdcode);
          if (!option) {
                                                                                     
                                                                                     
                                                                                  
            return designToolFailure(
              'SET_PCR_POLYMERASE_FAILED',
              {
                ...base,
                status: 'rejected' as const,
                code: 'unknown-prodcode',
                error: `Unknown NEB product code: ${requestedProdcode}`,
                supportedProdcodes: [...PRODCODES],
              },
              effects
            );
          }
          if (requestedFamily !== undefined && option.family !== requestedFamily) {
            return designToolFailure(
              'SET_PCR_POLYMERASE_FAILED',
              {
                ...base,
                status: 'rejected' as const,
                code: 'BAD_INPUT',
                error:
                  `prodcode "${requestedProdcode}" is in the ${option.family} family, not ` +
                  `${requestedFamily}. Send just one of them, or a matching pair.`,
                prodcodeFamily: option.family,
                requestedFamily,
                prodcodesInRequestedFamily: prodcodesInFamily(requestedFamily),
              },
              effects
            );
          }
          target = option;
          resolvedFrom = 'prodcode';
        } else if (requestedFamily !== undefined) {
          const option = firstOptionForFamily(requestedFamily);
          if (!option) {
            return designToolFailure(
              'SET_PCR_POLYMERASE_FAILED',
              {
                ...base,
                status: 'rejected' as const,
                code: 'unknown-polymerase',
                error: `No NEB product is curated for the ${requestedFamily} family.`,
                supportedFamilies: [...POLYMERASE_FAMILIES],
                supportedProdcodes: [...PRODCODES],
              },
              effects
            );
          }
          target = option;
          resolvedFrom = 'family';
        }

        const previousProdcode = design.pcrPolymerase ?? null;
        const nextProdcode = target?.prodcode ?? null;
        const familyOptions = target ? prodcodesInFamily(target.family) : [];
                                                                                    
                                                                               
        const tmModel = target
          ? resolveTmModel({ reaction: { polymerase: target.prodcode } })
          : null;

        if (previousProdcode === nextProdcode) {
                                                                                 
                                                                                    
          return toolSuccess({
            ...base,
            status: 'noop' as const,
            polymerase: projectProdcode(nextProdcode),
            previousPolymerase: projectProdcode(previousProdcode),
            tmModel,
            resolvedFrom,
            familyOptions,
            previousVersion: design.version,
            designVersion: design.version,
            note: wantsClear
              ? 'This design already had no polymerase set.'
              : `This design was already set to ${nextProdcode}.`,
          });
        }

        const previousVersion = design.version;
        const guardVersion = expectedDesignVersion ?? design.version;
        const nextTmCalculator = createAppTmCalculator(nextProdcode);

        const nextDesign: SequenceDesign = {
          ...design,
          pcrPolymerase: nextProdcode,
                                                                                
                                                                                  
                                                                                 
                                                           
          designPrimers: recomputeDesignPrimerTms(design.designPrimers, nextTmCalculator),
          version: previousVersion + 1,
          updatedAt: new Date(),
        };

        effects.attemptedMutation();
        const committed = useDesignStore
          .getState()
          .commitWorkbenchDesign(design.id, nextDesign, guardVersion);

        if (!committed) {
          effects.unchanged();
                                                                                   
                                                                                  
                                                                         
          const current = useDesignStore.getState().designs[designId] as SequenceDesign | undefined;
          return designToolFailure(
            'SET_PCR_POLYMERASE_FAILED',
            {
              ...base,
              status: 'rejected' as const,
              code: 'stale-design-version',
              error:
                'The design changed before this edit could be committed. Re-read it with ' +
                'get_design and retry.',
              previousVersion,
              currentVersion: current?.version ?? null,
              currentPolymerase: projectProdcode(current?.pcrPolymerase ?? null),
              retriable: true,
            },
            effects
          );
        }

        effects.changed({ kind: 'design-edited', designId });
        const next = (useDesignStore.getState().designs[designId] ?? nextDesign) as SequenceDesign;

        const warnings =
          pcrPartCount(next) === 0
            ? [
                {
                  code: 'no-pcr-parts',
                  message:
                    'This design has no PCR-amplified parts yet, so the polymerase does not ' +
                    'affect anything until PCR parts are added. The setting is recorded.',
                },
              ]
            : [];

        return toolSuccess({
          ...base,
          status: 'applied' as const,
          polymerase: projectProdcode(nextProdcode),
          previousPolymerase: projectProdcode(previousProdcode),
          tmModel,
          resolvedFrom,
                                                                              
                                                             
          familyOptions,
          previousVersion,
          designVersion: next.version,
          warnings,
                                                                                 
                                                                               
                                                                          
          revalidationRequired: true,
          mutation: createDesignMutationClaim({
            operationId: context?.toolCallId,
            toolName: 'set_pcr_polymerase',
            effect: 'set_pcr_polymerase',
            designId,
            beforeVersion: previousVersion,
            afterVersion: next.version,
            changed: true,
            expected: {
              polymerase: nextProdcode,
              previousPolymerase: previousProdcode,
            },
          }),
        });
      } catch (error) {
        return designToolFailure(
          'SET_PCR_POLYMERASE_FAILED',
          {
            ...base,
            status: 'rejected' as const,
            code: 'EXECUTION_FAILED',
            error: `Failed to set PCR polymerase: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          effects
        );
      }
    }),
});
