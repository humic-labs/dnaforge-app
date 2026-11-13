import { z } from 'zod';
import { listSavedMolecularViews } from '../../../db/entity-references';
import { getCurrentWorkspaceScope } from '../../../stores/workspaceStore';
import {
  attachSavedInspectionStructure,
  compareInspectionProteins,
} from '../../structure-drawer/public/inspection-comparison';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { listInspectionPredictions, reuseInspectionPrediction } from '../../structure-drawer/public/inspection-prediction';
import { discoverProteinPredictions } from '../../compute/public/prediction-library';
import { openProteinPrediction } from '../../compute/public/prediction-result-view';

export const proteinStructureComparisonSchema = z
  .object({
    action: z.enum(['list-saved', 'attach', 'compare', 'list-predictions', 'reuse-prediction', 'open-prediction']),
    proteinSequence: z.string().min(1).max(24000).optional().describe(
      'Exact amino-acid sequence for prediction discovery without an open inspection, or for open-prediction.'
    ),
    documentId: z.string().min(1).optional().describe(
      'Source document with an already selected protein inspection. For list-predictions without an inspection, provide proteinSequence instead.'
    ),
    referenceId: z.string().min(1).optional(),
    chainId: z.string().min(1).optional(),
  })
  .strict();
export function createProteinStructureComparisonTool() {
  return resultTool({
    description:
      'Use list-predictions with proteinSequence or an inspected documentId to discover exact protein matches across this computer. Results retain each run, settings identity and chain. reuse-prediction attaches referenceId/chainId to the current inspection without submitting compute or copying another analysis. After reuse-prediction, call mol_list_structures and use its current structureViewId for subsequent viewer tools; the previous inspection ID can refer to the replaced coordinates. open-prediction opens a standalone result with proteinSequence. List saved structures in this workspace, attach a saved view to the currently inspected reference or allele after exact sequence verification, or compare both saved products. Comparison keeps actual coordinate models separate and aligns unchanged residues; it never invents alternate atoms. Inspect the product first, use mol_save_view to save each input, then compare and observe mol_get_state. Use mol_get_scene/mol_apply_scene for arbitrary appearance and mol_save_view to preserve the comparison.',
    inputSchema: proteinStructureComparisonSchema,
    execute: async ({ action, documentId, referenceId, chainId, proteinSequence }) => {
      try {
        if (action === 'list-predictions') {
          if (!proteinSequence && !documentId) throw new Error('Specify a proteinSequence or an inspected documentId.');
          return toolSuccess(await (proteinSequence ? discoverProteinPredictions(proteinSequence) : listInspectionPredictions(documentId!)));
        }
        if (action === 'open-prediction') {
          if (!proteinSequence || !referenceId || !chainId) throw new Error('Specify the proteinSequence, prediction referenceId and chainId.');
          return toolSuccess(await openProteinPrediction(referenceId, proteinSequence, chainId));
        }
        if (action === 'list-saved')
          return toolSuccess({ views: await listSavedMolecularViews(getCurrentWorkspaceScope()) });
        if (!documentId) throw new Error('Specify the source sequence documentId.');
        if (action === 'reuse-prediction') {
          if (!referenceId || !chainId) throw new Error('Specify the prediction referenceId and matching chainId.');
          const result = await reuseInspectionPrediction(documentId, referenceId, chainId);



          return toolSuccess({
            ...result,
            nextAction: {
              tool: 'mol_list_structures',
              input: {},
              reason:
                'Resolve the current structureViewId after reusing prediction coordinates. Use the exact returned ID for viewer tools; do not reuse the earlier inspection ID.',
            },
          });
        }
        if (action === 'attach') {
          if (!referenceId) throw new Error('Specify a saved molecular view referenceId.');
          return toolSuccess(
            await attachSavedInspectionStructure(documentId, referenceId, chainId)
          );
        }
        return toolSuccess({
          comparison: await compareInspectionProteins(documentId),
          status: 'loading',
        });
      } catch (error) {
        return toolFailure({
          code: 'PROTEIN_COMPARISON_FAILED',
          error: error instanceof Error ? error.message : String(error),
          retriable: false,
          stateChanged: 'unknown',
          partialEffects: [],
        });
      }
    },
  });
}
