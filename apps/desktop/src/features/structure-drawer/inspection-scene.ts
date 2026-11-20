import type { ResidueSelection } from '@waypoint/workspace-editor';
import {
  validateMolecularViewCoordinates,
  type MolecularView,
} from '../page/public/embeds/structure3d/molecularView';
import {
  getMolViewSpecScene,
  waitForMolViewSpecViewReady,
  applyMolViewSpecScene,
} from '../page/public/embeds/structure3d/molstar/molViewSpec';
import {
  withActivePlugin,
  getStructureKey,
  getPaneRendererHostCacheKey,
} from '../page/public/embeds/structure3d/viewerCache';
import { getMolstarPropsFromAttrs } from '../page/public/embeds/structure3d/utils/molstarPropsUtils';
import { structureKeyOverrideForAttrs } from '../page/public/embeds/structure3d/utils/structureSourceIdentity';
import type { Structure3dAttrs } from '../page/public/embeds/structure3d/types';
import { useStructure3dStore } from '../page/public/embeds/structure3d/store';
import { extractSequenceDataFromPlugin } from '../page/public/embeds/structure3d/hooks/useSequenceData';
import { focusOnResidues } from '../page/public/embeds/structure3d/hooks/useResidueHighlight';
import { residueTargetsFromExtractedQueryChains } from '../page/public/embeds/structure3d/utils/structureLinkTargets';
import { residueSelectionsToStructureResidues } from '../page/public/embeds/structure3d/utils/residueSelectionBridge';
import { useStructureLinkRegistry } from './state/use-structure-link-registry';
import { compileMeasurementScene } from './measurement-scene';
import { sha256Hex } from './api/protein-identity';

export async function initializeInspectionScene(attrs: Structure3dAttrs, rendererHostId: string) {
  if (attrs.molViewSpec) return attrs;
  const registrationId = attrs.structureViewIdentity?.structureViewId;
  if (!registrationId) throw new Error('The protein view has no registered identity.');
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
  const current = () => {
    const entry = useStructure3dStore.getState().expandedStructures[registrationId];
    if (!entry || entry.data.structureLinkOwnerId !== attrs.structureLinkOwnerId)
      throw new Error('The protein changed before its initial scene was ready.');
    return entry.data;
  };
  return withActivePlugin(
    key,
    async ({ plugin }) => {
      const startingAttrs = current();
      const measurement = startingAttrs.measurements?.find(
        (item) => item.id === startingAttrs.activeMeasurementId
      );
      if (startingAttrs.activeMeasurementId && !measurement)
        throw new Error('The selected measurement is missing from this protein view.');
      const assertSceneCurrent = () => {
        const latest = current();
        if (
          latest.activeMeasurementId !== startingAttrs.activeMeasurementId ||
          JSON.stringify(
            latest.measurements?.find((item) => item.id === startingAttrs.activeMeasurementId)
          ) !== JSON.stringify(measurement)
        )
          throw new Error('The selected measurement changed before its initial scene was ready.');
        return latest;
      };
      const initial = getMolViewSpecScene(plugin);
      let scene = initial.scene;
      if (measurement) {
        const link = Object.values(useStructureLinkRegistry.getState().links).find(
          (entry) =>
            entry.structureViewId === registrationId && entry.ownerId === attrs.structureLinkOwnerId
        );
        if (!link || sha256Hex(link.translation) !== measurement.proteinSequenceSha256)
          throw new Error('The selected measurement has no verified mapping to this protein.');
        const chains =
          extractSequenceDataFromPlugin(plugin, 'chain', !!startingAttrs.comparisonProvenance)
            ?.chains ?? [];
        const residueTargets = residueTargetsFromExtractedQueryChains(
          startingAttrs,
          chains,
          link.translation
        );
        scene = compileMeasurementScene(
          scene,
          measurement,
          { residueTarget: residueTargets[0], residueTargets },
          startingAttrs.comparisonProvenance
        ).scene;
      }
      if (initial.sceneOrigin === 'starter' || measurement)
        await applyMolViewSpecScene(plugin, scene, assertSceneCurrent);
      const latest = assertSceneCurrent();
      const updated = {
        ...latest,
        molViewSpec: getMolViewSpecScene(plugin).scene,
        molViewSpecSnapshotIndex: 0,
        view: undefined,
      };
      useStructure3dStore.getState().updateStructureData(registrationId, updated);
      return updated;
    },
    { cacheKey: getPaneRendererHostCacheKey(rendererHostId, 'loaded') }
  );
}

export async function focusInspectionSelection(
  attrs: Structure3dAttrs,
  rendererHostId: string,
  selections: ResidueSelection[],
  isCurrent: () => boolean
): Promise<boolean> {
  const registrationId = attrs.structureViewIdentity?.structureViewId;
  if (!registrationId) throw new Error('The protein view has no registered identity.');
  const current = () => {
    const entry = useStructure3dStore.getState().expandedStructures[registrationId];
    if (!isCurrent() || !entry || entry.data.structureLinkOwnerId !== attrs.structureLinkOwnerId)
      throw new Error('The inspected mutation changed before its camera was ready.');
    return entry.data;
  };
  const props = getMolstarPropsFromAttrs(attrs.source ?? 'pdb', attrs);
  return withActivePlugin(
    structureKeyOverrideForAttrs(attrs) ??
      getStructureKey(
        props.pdbId,
        props.uniprotId,
        props.url,
        props.structureData,
        props.structureIdentity,
        undefined,
        props.coordinateModel
      ),
    async ({ plugin }) => {
      const latest = current();
      const link = Object.values(useStructureLinkRegistry.getState().links).find(
        (entry) =>
          entry.structureViewId === registrationId && entry.ownerId === attrs.structureLinkOwnerId
      );
      if (!link) throw new Error('The protein residue mapping is not ready.');
      const chains =
        extractSequenceDataFromPlugin(plugin, 'chain', !!latest.comparisonProvenance)?.chains ?? [];
      const residueTargets = residueTargetsFromExtractedQueryChains(
        latest,
        chains,
        link.translation
      );
      const residues = residueSelectionsToStructureResidues({
        structureId: link.structureId,
        link: { ...link, residueTarget: residueTargets[0], residueTargets },
        selections,
      });
      if (!focusOnResidues(plugin, residues)) return false;
      await waitForMolViewSpecViewReady(plugin);
      useStructure3dStore.getState().updateStructureData(registrationId, {
        ...current(),
        cameraSnapshot: JSON.stringify(plugin.canvas3d?.camera.getSnapshot()),
      });
      return true;
    },
    { cacheKey: getPaneRendererHostCacheKey(rendererHostId, 'loaded') }
  );
}

export async function loadInspectionDocument(referenceId: string) {
  const { resolveMolecularDocumentResult } =
    await import('../molecular-documents/public/references');
  const resolved = await resolveMolecularDocumentResult(referenceId);
  await validateMolecularViewCoordinates(resolved.snapshot);
  return resolved;
}

export async function loadInspectionScene(referenceId: string): Promise<MolecularView> {
  return (await loadInspectionDocument(referenceId)).snapshot;
}
