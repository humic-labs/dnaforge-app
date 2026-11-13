import { useCanvasStore } from '../canvas/public/store';
import {
  coordinateDigest,
  type MolecularView,
} from '../page/public/embeds/structure3d/molecularView';
import {
  buildProteinComparisonCoordinates,
  buildProteinComparisonScene,
  readVerifiedProteinChain,
} from '../page/public/embeds/structure3d/proteinComparison';
import { alleleStructureRequest, inspectionAlleleProvenance } from './inspection-allele';
import { loadInspectionScene } from './inspection-scene';
import {
  inspectionProteinKey,
  openStructureInspection,
  structureInspectionId,
  type StructureInspection,
} from './structure-inspection';

export type InspectionScene = Pick<
  MolecularView,
  'coordinates' | 'source' | 'scene' | 'initialSnapshotIndex' | 'cameraSnapshot' | 'molecularData'
>;
import type { InspectionComparison } from './public/inspection-types';
import { textCoordinates } from '../../shared/binary-coordinates';
export type { InspectionComparison } from './public/inspection-types';
function active(documentId: string) {
  const canvas = useCanvasStore.getState();
  const where = canvas.findTab('structure', structureInspectionId(documentId));
  const inspection =
    where &&
    canvas.panels[where.panelId]?.tabs.find((t) => t.id === where.tabId)?.structureInspection;
  if (!where || !inspection) throw new Error('Open a mutation inspection first.');
  return { where, inspection };
}
function requireCurrent(documentId: string, prior: StructureInspection) {
  const next = active(documentId);
  if (
    next.inspection.request !== prior.request ||
    next.inspection.candidateId !== prior.candidateId ||
    next.inspection.savedViewReferenceId !== prior.savedViewReferenceId
  )
    throw new Error('The selected protein changed while loading its structure.');
  return next;
}
export async function attachSavedInspectionStructure(
  documentId: string,
  referenceId: string,
  chainId?: string
) {
  const { inspection } = active(documentId);
  if (inspection.request.comparisonOf)
    throw new Error('Choose the reference or allele product before attaching its structure.');
  const view = await loadInspectionScene(referenceId);
  if (view.source.comparison)
    throw new Error('Choose one saved protein model, not an existing comparison.');
  await readVerifiedProteinChain({
    ...textCoordinates(view.coordinates),
    sequence: inspection.request.translation,
    chainId,
  });
  const { where, inspection: latest } = requireCurrent(documentId, inspection);
  useCanvasStore.getState().updateTab(where.panelId, where.tabId, {
    structureInspection: {
      ...latest,
      candidateId: `saved:${referenceId}`,
      savedViewReferenceId: referenceId,
      attachedChainId: chainId,
      viewSettings: undefined,
      prediction: undefined,
      measurements: view.measurements,
      activeMeasurementId: view.activeMeasurementId,
    },
  });
  return { referenceId, proteinKey: inspectionProteinKey(inspection.request) };
}
export async function compareInspectionProteins(documentId: string): Promise<InspectionComparison> {
  const { inspection } = active(documentId);
  const reference =
    inspection.request.comparisonOf ?? inspection.request.alleleOf ?? inspection.request;
  const allele = alleleStructureRequest(reference);
  const getView = (key: string) =>
    key === inspectionProteinKey(inspection.request)
      ? inspection
      : inspection.retainedProteinViews?.[key];
  const ref = getView(inspectionProteinKey(reference));
  const alt = getView(inspectionProteinKey(allele));
  if (!ref?.savedViewReferenceId || !alt?.savedViewReferenceId)
    throw new Error(
      'Save or attach a structure for both the reference and allele before comparing them.'
    );
  const [refView, altView] = await Promise.all([
    loadInspectionScene(ref.savedViewReferenceId),
    loadInspectionScene(alt.savedViewReferenceId),
  ]);
  const comparison: InspectionComparison = {
    referenceId: ref.savedViewReferenceId,
    alternateId: alt.savedViewReferenceId,
    referenceSha256: refView.coordinates.sha256,
    alternateSha256: altView.coordinates.sha256,
    referenceChain: ref.attachedChainId,
    alternateChain: alt.attachedChainId,
  };
  const identity = await coordinateDigest(
    JSON.stringify([inspectionProteinKey(reference), comparison])
  );
  const request = {
    ...reference,
    comparisonOf: reference,
    identityRequestKey: `comparison:${identity}`,
    cdsLabel: `${reference.cdsLabel ?? 'Protein'} · reference / allele`,
  };
  const candidateId = `comparison:${identity}`;
  await loadInspectionComparison({ request, comparison });
  requireCurrent(documentId, inspection);
  const reason = openStructureInspection(request, [], { comparison, candidateId });
  if (reason) throw new Error(reason);
  return comparison;
}
export async function loadInspectionComparison(
  inspection: StructureInspection
): Promise<InspectionScene> {
  const descriptor = inspection.comparison;
  const reference = inspection.request.comparisonOf;
  if (!descriptor || !reference) throw new Error('The comparison sources are missing.');
  const allele = alleleStructureRequest(reference);
  const provenance = inspectionAlleleProvenance(allele)!;
  const [ref, alt] = await Promise.all([
    loadInspectionScene(descriptor.referenceId),
    loadInspectionScene(descriptor.alternateId),
  ]);
  if (ref.source.comparison || alt.source.comparison)
    throw new Error('A comparison requires two individual protein models.');
  if (
    ref.coordinates.sha256 !== descriptor.referenceSha256 ||
    alt.coordinates.sha256 !== descriptor.alternateSha256
  )
    throw new Error('A saved comparison source has changed.');
  const coordinates = await buildProteinComparisonCoordinates({
    reference: {
      ...textCoordinates(ref.coordinates),
      sequence: reference.translation,
      chainId: descriptor.referenceChain,
    },
    alternate: {
      ...textCoordinates(alt.coordinates),
      sequence: allele.translation,
      chainId: descriptor.alternateChain,
    },
    alternateToReference: provenance.alternateToReference,
  });
  const sha256 = await coordinateDigest(coordinates.text);
  const source = (view: MolecularView, referenceId: string, sequence: string, chainId: string) => ({
    ...view.source,
    referenceId,
    title: view.title,
    sequence,
    chainId,
    coordinates: view.coordinates,
    allele: undefined,
    comparison: undefined,
  });
  const inputSource = (
    view: MolecularView,
    referenceId: string,
    sequence: string,
    chainId: string
  ) => {
    const {
      allele: _allele,
      comparison: _comparison,
      ...value
    } = source(view, referenceId, sequence, chainId);
    return value;
  };
  return {
    coordinates: { format: coordinates.format, text: coordinates.text, sha256 },
    scene: buildProteinComparisonScene(coordinates),
    source: {
      source: 'file',
      comparison: {
        reference: inputSource(
          ref,
          descriptor.referenceId,
          reference.translation,
          coordinates.referenceChain
        ),
        alternate: inputSource(
          alt,
          descriptor.alternateId,
          allele.translation,
          coordinates.alternateChain
        ),
        allele: provenance,
        coordinateSha256: sha256,
        alignment: coordinates.alignment,
      },
    },
  };
}
