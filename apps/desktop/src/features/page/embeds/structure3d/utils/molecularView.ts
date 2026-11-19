import { structureCoordinateScores } from './structureScoreState';
import type { Structure3dAttrs } from '../types';
import {
  validateMolecularViewCoordinates as validatePinnedMolecularViewCoordinates,
  type MolecularView,
} from '../../../../../shared/molecular-view';
import { molViewSpecStorySteps } from './molViewSpecStory';
import { molViewSpecColorGroups } from '../molstar/molViewSpecLegend';
import { molecularReferenceSnapshotIndex } from '../../../../../shared/molecular-reference';
import { canonicalJson } from '../../../../../shared/canonical-json';
import { isDefaultMolecularScene } from '../../../../../shared/default-molecular-view';

export * from '../../../../../shared/molecular-view';

export function sameMolecularViewData(
  view: Pick<MolecularView, 'measurements' | 'activeMeasurementId' | 'molecularData'>,
  attrs: Pick<Structure3dAttrs, 'measurements' | 'activeMeasurementId' | 'molecularData'>
): boolean {
  return (
    canonicalJson([
      view.measurements ?? [],
      view.activeMeasurementId ?? null,
      view.molecularData ?? null,
    ]) ===
    canonicalJson([
      attrs.measurements ?? [],
      attrs.activeMeasurementId ?? null,
      attrs.molecularData ?? null,
    ])
  );
}

function molecularViewSteps(view: MolecularView): { index: number; title: string; id?: string }[] {
  const steps = molViewSpecStorySteps(view.scene);
  if (steps.length) return steps;
  const key = JSON.parse(view.scene).metadata?.key;
  return [{ index: 0, title: view.title, ...(typeof key === 'string' && key ? { id: key } : {}) }];
}

export function molecularViewTargetSnapshotIndex(
  view: MolecularView,
  target: { viewId?: string; snapshotIndex?: number }
): number {
  return molecularReferenceSnapshotIndex(view, target);
}

export async function validateMolecularViewCoordinates(view: MolecularView): Promise<void> {
  await validatePinnedMolecularViewCoordinates(view);
  if (view.version === 2) {
    const { validateMolViewSpecScene } = await import('../molstar/molViewSpec');
    validateMolViewSpecScene(view.scene, [
      `structure.${view.coordinates.format}`,
      ...view.pinnedAssets.map((asset) => asset.name),
    ]);
  }
}

export function molecularViewReferenceTargets(viewReferenceId: string, view: MolecularView) {
  const steps = molecularViewSteps(view);
  return steps.map((step) => {
    const selection = {
      kind: 'molecular_view_target' as const,
      viewReferenceId,
      snapshotIndex: step.index,
      ...('id' in step && step.id ? { viewId: step.id } : {}),
    };
    return {
      label: step.title,
      selection,
      namedSelections: molViewSpecColorGroups(view.scene, step.index)
        .filter((group) => group.selectable)
        .map((group) => ({ label: group.label, selection: { ...selection, groupId: group.id } })),
    };
  });
}

export function molecularViewAttrs(
  _entityId: string,
  view: MolecularView,
  selectedSnapshotIndex?: number,
  savedReferenceId?: string
): Structure3dAttrs {
  if (selectedSnapshotIndex !== undefined) {
    const steps = molViewSpecStorySteps(view.scene);
    if (
      !Number.isInteger(selectedSnapshotIndex) ||
      selectedSnapshotIndex < 0 ||
      selectedSnapshotIndex >= Math.max(1, steps.length)
    )
      throw new Error('The selected molecular story step does not exist.');
  }
  const defaultView = isDefaultMolecularScene(view.scene);
  return {
    coordinateSource: { sha256: view.coordinates.sha256, source: view.source },
    coordinateScores: structureCoordinateScores(view.coordinates.text, view.coordinates.sha256),
    molecularData: view.molecularData,
    coordinateModel: view.source.coordinateModel,
    catalogProvenance: view.source.catalogObservation,
    measurements: view.measurements,
    predictionProvenance: view.source.prediction,
    alleleProvenance: view.source.allele,
    comparisonProvenance: view.source.comparison,
    activeMeasurementId: view.activeMeasurementId,
    source: 'file',
    sourceId: view.coordinates.text,
    coordinateFormat: view.coordinates.format === 'bcif' ? 'bcif' : undefined,
    coordinateSha256: defaultView ? undefined : view.coordinates.sha256,
    molViewSpecAssets: view.version === 2 ? view.pinnedAssets : undefined,
    molViewSpecPrimarySourceReferenceId:
      view.version === 2 ? view.primarySourceReferenceId : undefined,
    label: view.title,
    description: view.caption,
    molViewSpec: defaultView ? undefined : view.scene,
    molViewSpecSavedReferenceId: defaultView ? undefined : savedReferenceId,
    molViewSpecSnapshotIndex: defaultView
      ? undefined
      : (selectedSnapshotIndex ?? view.initialSnapshotIndex),
    cameraSnapshot: view.cameraSnapshot,
    view: undefined,
    highlightGroups: [],
    residueColorLayers: [],
  };
}

export function molecularViewSourceForCoordinates(
  attrs: Structure3dAttrs,
  coordinates: Pick<MolecularView['coordinates'], 'sha256'>,
  current: MolecularView['source']
): MolecularView['source'] {
  const original = attrs.coordinateSource;
  if (!original || original.sha256 !== coordinates.sha256 || current.source !== 'file')
    return current;
  const metadata = Object.fromEntries(
    Object.entries(current).filter(
      ([key, value]) =>
        value !== undefined && !['source', 'sourceId', 'providerIdentityKey'].includes(key)
    )
  );
  return { ...original.source, ...metadata };
}
