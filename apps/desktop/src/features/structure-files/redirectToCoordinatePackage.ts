import { platform } from '../../platform';
import { useCanvasStore } from '../canvas/public/store';
import { coordinateFileStem } from '../../shared/default-molecular-view';
import { MOLECULAR_DOCUMENT_SUFFIX } from '../../shared/molecular-document';

export async function redirectTabToCoordinatePackage(
  tabId: string,
  coordinatePath: string,
  coordinateDigestSha256: string
): Promise<boolean> {
  const slash = Math.max(coordinatePath.lastIndexOf('/'), coordinatePath.lastIndexOf('\\'));
  if (slash < 0) return false;
  const packagePath = `${coordinatePath.slice(0, slash)}/${coordinateFileStem(
    coordinatePath.slice(slash + 1)
  )}${MOLECULAR_DOCUMENT_SUFFIX}`;
  if (!(await platform().fs.exists(packagePath))) return false;
  const { readMolecularDocument } = await import('../molecular-documents/public/services');
  const saved = await readMolecularDocument(packagePath);
  if (
    !saved.document.history.some(
      ({ snapshot }) => snapshot.coordinates.sha256 === coordinateDigestSha256
    )
  )
    return false;
  const state = useCanvasStore.getState();
  const panel = Object.values(state.panels).find((candidate) =>
    candidate.tabs.some((tab) => tab.id === tabId)
  );
  if (!panel) return false;
  state.retargetTab(
    panel.id,
    tabId,
    { type: 'structure', entityId: `molecular-document:${saved.catalogEntityId}` },
    {
      label: saved.document.name,
      initialStructureAttrs: {
        source: 'file',
        sourceId: '',
        label: saved.document.name,
        molecularDocumentId: saved.document.id,
        molecularDocumentPath: saved.path,
        molecularDocumentRevision: saved.revision,
        molecularDocumentSavedReferenceId: saved.document.currentReferenceId,
      },
    }
  );
  return true;
}
