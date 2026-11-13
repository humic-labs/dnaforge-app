import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { useCanvasStore } from '../canvas/public/store';
import { useStructure3dStore } from '../page/public/embeds/structure3d/store';
import { structureInspectionId } from '../structure-drawer/public/structure-inspection';
import { applyInspectionMeasurement } from '../structure-drawer/public/apply-inspection-measurement';
import { loadVariantAnalysis } from './variant-analysis';
import {
  buildVariantProteinMeasurement,
  variantProteinMeasurementIdentity,
  type VariantProteinMeasurementOptions,
} from './variant-protein-measurement';

export async function applyVariantProteinMeasurement(
  input: VariantProteinMeasurementOptions & {
    analysisId: string;
    baselineAnalysisId?: string;
    sequence: AnnotatedSequence;
  }
) {
  const analysis = await loadVariantAnalysis(input.analysisId);
  const baseline = input.baselineAnalysisId
    ? {
        analysisId: input.baselineAnalysisId,
        analysis: await loadVariantAnalysis(input.baselineAnalysisId),
      }
    : undefined;
  const canvas = useCanvasStore.getState();
  const host = canvas.findTab('structure', structureInspectionId(analysis.documentId));
  const panel = host ? canvas.panels[host.panelId] : undefined;
  const tab = panel?.tabs.find((tab) => tab.id === host?.tabId);
  const inspection = tab?.structureInspection;
  const activeViewId = inspection?.viewSettings?.structureViewId;
  const entry = activeViewId
    ? useStructure3dStore.getState().expandedStructures[activeViewId]
    : undefined;
  if (!host || !tab || panel?.activeTabId !== tab.id || !inspection || !entry)
    throw new Error(
      'Select a coding mutation and wait for its protein to load before coloring it.'
    );
  const built = buildVariantProteinMeasurement({
    ...input,
    analysis,
    baseline,
    request: inspection.request,
  });

  const existing = entry.data.measurements?.find(
    (item) => item.variantEvidence && variantProteinMeasurementIdentity(item) === built.id
  );

  const measurement = existing ? { ...built, id: existing.id } : built;
  const rendered = await applyInspectionMeasurement(entry.data, host.panelId, measurement);
  return { measurement, ...rendered };
}
