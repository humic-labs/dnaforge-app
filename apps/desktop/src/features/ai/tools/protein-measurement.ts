import { z } from 'zod';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import {
  residueMeasurementSchema,
  log2Enrichment,
  MEASUREMENT_CORRESPONDENCE_DESCRIPTION,
} from '../../page/public/embeds/structure3d/residueMeasurement';
import { useStructure3dStore } from '../../page/public/embeds/structure3d/store';
import { useCanvasStore } from '../../canvas/public/store';
import { applyInspectionMeasurement } from '../../structure-drawer/public/apply-inspection-measurement';

export const proteinMeasurementSchema = z
  .object({
    structureViewId: z
      .string()
      .min(1)
      .describe(
        'Exact logical view from mol_get_state; the linked protein sequence SHA-256 is also returned there.'
      ),
    measurement: residueMeasurementSchema
      .innerType()
      .partial({ values: true })
      .transform((input, context) => {
        let values = input.values;
        try {
          if (input.derivation)
            values = log2Enrichment(input.derivation.counts, input.derivation.pseudocount);
        } catch (error) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: error instanceof Error ? error.message : String(error),
          });
          return z.NEVER;
        }
        const parsed = residueMeasurementSchema.safeParse({ ...input, values });
        if (!parsed.success) {
          for (const issue of parsed.error.issues) context.addIssue(issue);
          return z.NEVER;
        }
        return parsed.data;
      })
      .describe(
        'The built-in derivation calculates table-normalized log2 enrichment, not an alternate/reference count ratio. For other derivatives calculate your own values from the original observations and supply values, or publish your exact table with mol_data.'
      ),
  })
  .strict();

export const PROTEIN_MEASUREMENT_DESCRIPTION =
  'Apply a named numeric or derived measurement to the protein linked to mutation analysis. For saved VCF or raw-read allele fractions and sample comparisons, use color_variant_protein with analysisId; it derives values and evidence from the complete saved calls. Use this tool for supplied residue values or count-table enrichment. The only top-level inputs are structureViewId and measurement. Inside measurement supply id, name, proteinSequenceSha256, source: {label, analysisId, revision}, units, scale, and values or derivation. source and units belong inside measurement. ' +
  MEASUREMENT_CORRESPONDENCE_DESCRIPTION +
  ' Read mol_get_state for the exact view and protein identity. Use one-based encoded protein positions. scale.domain is exactly [minimum, maximum]; scale.colors contains evenly spaced palette stops, and scale.missingColor distinguishes unknown values from zero. For table-normalized log2 enrichment supply derivation: {kind: "log2-enrichment", normalization: "table-total", pseudocount, counts: [{residue, before, after}]}. Each count column is normalized separately across all supplied rows, so a one-row table always yields zero; this is not alternate/reference allele odds. For ratios or any other derivative, calculate values from the original observations in your own script and supply values, or publish the exact output table with mol_data. Preserve the formula and actual source provenance. The result returns the actual stored values and derivation; inspect these before saving. The app verifies the protein revision, maps exact chains/residues/operators, reports missing coordinates, and authors MolViewSpec colors on loaded geometry. Use mol_save_view afterward to pin the scene and measurements. This does not compute mutant coordinates.';

export function createProteinMeasurementTool() {
  return resultTool({
    description: PROTEIN_MEASUREMENT_DESCRIPTION,
    inputSchema: proteinMeasurementSchema,
    execute: async ({ structureViewId, measurement }) => {
      const entry = useStructure3dStore.getState().expandedStructures[structureViewId];
      const panel = Object.values(useCanvasStore.getState().panels).find((panel) =>
        panel.tabs.some(
          (tab) =>
            tab.id === panel.activeTabId &&
            tab.type === 'structure' &&
            (tab.initialStructureAttrs?.structureViewIdentity?.structureViewId ===
              structureViewId ||
              tab.structureInspection?.viewSettings?.structureViewId === structureViewId)
        )
      );
      if (!entry || !panel)
        return toolFailure({
          code: 'PROTEIN_VIEW_NOT_FOUND',
          error: 'Open the linked protein inspection before applying a measurement.',
          retriable: false,
          stateChanged: false,
          partialEffects: [],
        });
      try {
        const result = await applyInspectionMeasurement(entry.data, panel.id, measurement);
        return toolSuccess({
          structureViewId,
          measurementId: measurement.id,
          rendered: true,
          values: measurement.values,
          derivation: measurement.derivation,
          mappedResidues: result.mappedResidues,
          unmappedResidues: result.unmappedResidues,
          message:
            'The measurement is rendered and retained with this protein inspection. Save the view to pin coordinates and attach it to the answer.',
        });
      } catch (error) {
        return toolFailure({
          code: 'PROTEIN_MEASUREMENT_FAILED',
          error: error instanceof Error ? error.message : String(error),
          retriable: false,
          stateChanged: 'unknown',
          partialEffects: [],
        });
      }
    },
  });
}
