   
                                                         
  
                                                                 
                                                                                
                                                                         
                                                                              
                                                                     
  
                                                                              
                                                              
   

import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { runDesignTool } from './design-tool-result';
import { z } from 'zod';
import type { TmModel } from '../../design/public/algorithms/tm-model';
import {
  NEB_TM_OPTIONS,
  LOCAL_SELECT_VALUE,
  OWCZARZY_SELECT_VALUE,
  tmModelSelectValue,
  tmModelFromSelectValue,
} from '../../design/public/algorithms/tm-model';
import {
  resolveStoredPrimerTmModel,
  useSettingsStore,
} from '../../junction-workbench/public/settings';

                                                                                        
const VALID_MODEL_IDS = new Set<string>([
  LOCAL_SELECT_VALUE,
  OWCZARZY_SELECT_VALUE,
  ...NEB_TM_OPTIONS.map((o) => o.prodcode),
]);

export function resolveTmModelById(id: string): TmModel {
  return tmModelFromSelectValue(id);
}

                                                                                   
export function resolvePrimerTmModelForCall(input: {
  tmModel?: string | null;
  polymerase?: string | null;
}): TmModel {
  return resolveStoredPrimerTmModel({
    override: input.tmModel ? resolveTmModelById(input.tmModel) : null,
    polymerase: input.polymerase,
  }).model;
}

export function tmModelIdOf(model: TmModel): string {
  return tmModelSelectValue(model);
}

                                                                                 
export const configurePrimerTmSchema = z
  .object({
    model: z
      .string()
      .refine((v) => VALID_MODEL_IDS.has(v), {
        message:
          'Unknown Tm model. Use "local", "owczarzy", or an NEB product code such as ' +
          '"q5-0" (Q5), "phusion-0" (Phusion HF), "onetaq-0", or "taq-0".',
      })
      .describe(
        'App-wide method for calculating Tm of an already-known primer sequence. This does not ' +
          'choose primer sequences or configure Primer3 candidate search. "local" = offline ' +
          'SantaLucia; "owczarzy" = local SantaLucia with Owczarzy salt correction; or use an ' +
          'NEB product code (q5-0, q5hs-0, phusion-0/1, onetaq-0/1, taq-0, hstaq-0, lataq-0).'
      ),
  })
  .strict();

export const getPrimerTmConfigSchema = z.object({}).strict();

                                                            
export function applyPrimerTmModel(id: string): { modelId: string; model: TmModel } {
  const model = resolveTmModelById(id);
  useSettingsStore.getState().setTmModel(model);
  return { modelId: tmModelSelectValue(model), model };
}

                                         
export function readPrimerTmConfig(): { modelId: string; model: TmModel } {
  const model = useSettingsStore.getState().tmModel;
  return { modelId: tmModelSelectValue(model), model };
}

export const configurePrimerTmTool = resultTool({
  description:
    'Set the app-wide method for calculating Tm (melting temperature) of an already-known ' +
    'primer sequence. This does not choose primer sequences or configure Primer3 candidate search. ' +
    'Use "local" for SantaLucia, "owczarzy" for SantaLucia with Owczarzy salt correction, or ' +
    'an NEB product code such as "q5-0" or "phusion-0".',
  inputSchema: configurePrimerTmSchema as z.ZodTypeAny,
  execute: async ({ model }: z.infer<typeof configurePrimerTmSchema>) =>
    runDesignTool('CONFIGURE_PRIMER_TM_FAILED', async (effects) => {
      effects.attemptedMutation();
      const applied = applyPrimerTmModel(model);
      effects.changed({ kind: 'primer-tm-setting-changed', modelId: applied.modelId });
      return toolSuccess({ configured: true, ...applied });
    }),
});

export const getPrimerTmConfigTool = resultTool({
  description:
    'Read the app-wide method used to calculate Tm for already-known primer sequences. This is ' +
    'separate from Primer3 candidate search and ranking.',
  inputSchema: getPrimerTmConfigSchema as z.ZodTypeAny,
  execute: async () =>
    runDesignTool('GET_PRIMER_TM_CONFIG_FAILED', async () => toolSuccess(readPrimerTmConfig())),
});
