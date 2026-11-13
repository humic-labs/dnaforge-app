import { canonicalEncodedMolecule } from '../../shared/encoded-molecule';
import { loadCatalogStructure } from '../compute/public/molecular-catalog';
import { useCanvasStore } from '../canvas/public/store';
import { openStructureInspection, structureInspectionId } from './structure-inspection';

export async function attachCatalogToInspection(
  documentId: string,
  observationId: string,
  chainKey: string
): Promise<void> {
  const canvas = useCanvasStore.getState();
  const location = canvas.findTab('structure', structureInspectionId(documentId));
  const inspection =
    location &&
    canvas.panels[location.panelId]?.tabs.find((tab) => tab.id === location.tabId)
      ?.structureInspection;
  if (!inspection)
    throw new Error('Open the mutation inspection before choosing its saved structure.');
  const loaded = await loadCatalogStructure(observationId);
  const molecule = canonicalEncodedMolecule({
    kind: inspection.request.moleculeType ?? 'protein',
    sequence: inspection.request.translation,
  });
  const mapped = loaded.mappings.find(
    (item) =>
      item.chainKey === chainKey &&
      item.molecule.kind === molecule.kind &&
      item.molecule.sequence === molecule.sequence
  );
  if (!mapped || mapped.status !== 'mapped')
    throw new Error('This saved chain has no verified residue mapping for the selected molecule.');
  const chain = loaded.inventory.chains.find((item) => item.key === chainKey)!;
  if (loaded.observation.format === 'bcif')
    throw new Error(
      'Open these BinaryCIF coordinates in a structure tab. Mutation inspection currently requires text coordinates.'
    );
  const current = useCanvasStore
    .getState()
    .panels[location!.panelId]?.tabs.find((tab) => tab.id === location!.tabId)?.structureInspection;
  if (
    !current ||
    current.request.translation !== inspection.request.translation ||
    current.request.moleculeType !== inspection.request.moleculeType
  )
    throw new Error('The selected molecule changed while the structure was opening.');
  const error = openStructureInspection(current.request, current.selections, {
    catalogSource: { observationId, chainKey },
    attachedChainId: chain.labelAsymId,
    candidateId: `catalog:${observationId}:${chainKey}`,
    savedViewReferenceId: undefined,
    prediction: undefined,
    comparison: undefined,
    viewSettings: undefined,
  });
  if (error) throw new Error(error);
}
