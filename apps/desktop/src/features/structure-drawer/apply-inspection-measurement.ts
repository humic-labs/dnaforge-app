import { useStructure3dStore } from '../page/public/embeds/structure3d/store';
import {
  withActivePlugin,
  getStructureKey,
  getPaneRendererHostCacheKey,
} from '../page/public/embeds/structure3d/viewerCache';
import { getMolstarPropsFromAttrs } from '../page/public/embeds/structure3d/utils/molstarPropsUtils';
import { structureKeyOverrideForAttrs } from '../page/public/embeds/structure3d/utils/structureSourceIdentity';
import { getMolViewSpecCoordinates } from '../page/public/embeds/structure3d/molstar/molViewSpec';
import { useStructureLinkRegistry } from './state/use-structure-link-registry';
import type { Structure3dAttrs } from '../page/public/embeds/structure3d/types';
import type { ResidueMeasurement } from '../page/public/embeds/structure3d/residueMeasurement';
import { prepareInspectionMeasurementData } from './inspection-measurement-data';
import { coordinateDigest } from '../page/public/embeds/structure3d/molecularView';
import { useCanvasStore } from '../canvas/public/store';
import { sha256Hex } from './api/protein-identity';
import { extractSequenceDataFromPlugin } from '../page/public/embeds/structure3d/hooks/useSequenceData';
import { residueTargetsFromExtractedQueryChains } from '../page/public/embeds/structure3d/utils/structureLinkTargets';

export async function applyInspectionMeasurement(
  attrs: Structure3dAttrs,
  panelId: string,
  measurement: ResidueMeasurement
) {
  const registrationId = attrs.structureViewIdentity?.structureViewId;
  const link = Object.values(useStructureLinkRegistry.getState().links).find(
    (link) => link.structureViewId === registrationId && link.ownerId === attrs.structureLinkOwnerId
  );
  if (!registrationId || !link || sha256Hex(link.translation) !== measurement.proteinSequenceSha256)
    throw new Error(
      'This measurement belongs to a different protein revision or has no verified residue mapping.'
    );
  const assertCurrent = () => {
    const entry = useStructure3dStore.getState().expandedStructures[registrationId];
    const panel = useCanvasStore.getState().panels[panelId];
    const tab = panel?.tabs.find((tab) => tab.id === panel.activeTabId);
    const inspection = tab?.structureInspection;
    if (
      !entry ||
      entry.data.structureLinkOwnerId !== attrs.structureLinkOwnerId ||
      !tab ||
      (inspection
        ? inspection.viewSettings?.structureViewId !== registrationId ||
          inspection.request.entityId !== link.sequenceDocumentId ||
          inspection.request.translation !== link.translation ||
          !attrs.structureLinkOwnerId?.endsWith(`\u0000${tab.id}`)
        : tab.initialStructureAttrs?.structureViewIdentity?.structureViewId !== registrationId)
    )
      throw new Error(
        'The active protein changed. Read its current identity and apply the measurement again.'
      );
    const measurements = entry.data.measurements ?? [];
    if (measurements.length >= 20 && !measurements.some((item) => item.id === measurement.id))
      throw new Error(
        'This view already holds 20 measurements. Reuse an existing measurement identity or save a separate view.'
      );
  };
  assertCurrent();
  const props = getMolstarPropsFromAttrs(attrs.source ?? 'pdb', attrs);
  const key =
    structureKeyOverrideForAttrs(attrs) ??
    getStructureKey(
      props.pdbId,
      props.uniprotId,
      props.url,
      props.structureData,
      props.structureIdentity,
      undefined,
      props.coordinateModel
    );
  const prepared = await withActivePlugin(
    key,
    async ({ plugin }) => {
      assertCurrent();

      const currentAttrs = useStructure3dStore.getState().expandedStructures[registrationId].data;
      const chains =
        extractSequenceDataFromPlugin(plugin, 'chain', !!currentAttrs.comparisonProvenance)
          ?.chains ?? [];
      const residueTargets = residueTargetsFromExtractedQueryChains(
        currentAttrs,
        chains,
        link.translation
      );
      return prepareInspectionMeasurementData(
        measurement,
        {
          residueTarget: residueTargets[0],
          residueTargets,
        },
        await coordinateDigest(getMolViewSpecCoordinates(plugin).text)
      );
    },
    { cacheKey: getPaneRendererHostCacheKey(`pane:${panelId}`, 'loaded') }
  );
  assertCurrent();

  const { handleMolData } = await import('../agent-bridge/public/structure-tools');
  const current =
    useStructure3dStore.getState().expandedStructures[registrationId].data.molecularData;
  if (!current?.mappings.some((mapping) => mapping.revision === prepared.mapping.revision)) {
    const latest = [...(current?.datasets ?? [])]
      .reverse()
      .find((dataset) => dataset.id === prepared.dataset.id);
    const published = await handleMolData({
      operation: 'publish',
      structureViewId: registrationId,
      publication: prepared.publication,
      expectedRevision: latest?.revision,
    });
    if (!published.ok) throw new Error(published.error);
  }
  assertCurrent();
  const applied = await handleMolData({
    operation: 'apply',
    structureViewId: registrationId,
    layer: prepared.layer,
  });
  if (!applied.ok) throw new Error(applied.error);
  if (!('mappedRows' in applied))
    throw new Error('The measurement command did not return its mapped rows.');
  const mappedRows = new Set(applied.mappedRows);
  return {
    mappedResidues: measurement.values
      .filter((_, row) => mappedRows.has(row))
      .map((point) => point.residue),
    unmappedResidues: measurement.values
      .filter((_, row) => !mappedRows.has(row))
      .map((point) => point.residue),
  };
}
