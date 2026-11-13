import {
  getEntityReference,
  getEntityReferenceByLocator,
  type DBEntityReference,
} from '../../../db/entity-references';
import {
  resolveMolecularReference,
  molecularReferenceSnapshotIndex,
} from '../../../shared/molecular-reference';
import { validateMolecularViewCoordinates } from '../../../shared/molecular-view';
import {
  resolveMolecularDocumentReference,
  resolveLegacyMolecularDocumentReference,
  recoverMolecularDocumentRevision,
} from '../../molecular-documents/public/references';

export async function resolveMolecularReferenceSnapshot(
  reference: DBEntityReference,
  options: { sourceNotebookPageId?: string } = {}
) {
  const subject = resolveMolecularReference(reference);
  if (subject?.kind === 'document') {
    const document = await resolveMolecularDocumentReference(subject.document);
    return {
      subject,
      target: undefined,
      reference,
      view: document.snapshot,
      snapshotIndex: subject.document.viewId
        ? molecularReferenceSnapshotIndex(document.snapshot, { viewId: subject.document.viewId })
        : undefined,
      document,
    };
  }
  const target =
    subject?.kind === 'view' || subject?.kind === 'selection' ? subject.target : undefined;
  let parent = target ? await getEntityReference(target.viewReferenceId) : reference;
  if (subject?.kind === 'visualization' && !subject.view)
    parent = await getEntityReferenceByLocator(reference.locator);
  if (!parent && (target || subject?.kind === 'visualization')) {
    const recovered = await recoverMolecularDocumentRevision(
      target?.viewReferenceId ?? reference.id,
      options.sourceNotebookPageId
    );
    if (recovered)
      return {
        subject,
        target,
        reference,
        view: recovered.snapshot,
        snapshotIndex: target
          ? molecularReferenceSnapshotIndex(recovered.snapshot, target)
          : undefined,
        document: recovered,
      };
  }
  const pinned = parent && resolveMolecularReference(parent);
  const view = pinned?.kind === 'visualization' ? pinned.view : null;
  if (
    (target || subject?.kind === 'visualization') &&
    (!parent || parent.status !== 'created' || !view)
  )
    throw Error('The pinned molecular view is unavailable or unsupported.');
  if (view) await validateMolecularViewCoordinates(view);
  const snapshotIndex = target && view ? molecularReferenceSnapshotIndex(view, target) : undefined;
  const document = view
    ? await resolveLegacyMolecularDocumentReference(parent ?? reference, view, options)
    : undefined;
  return { subject, target, reference: parent ?? reference, view, snapshotIndex, document };
}
