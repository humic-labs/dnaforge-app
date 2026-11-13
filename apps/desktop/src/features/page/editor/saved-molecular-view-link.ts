import { getEntityReference } from '../../../db/entity-references';
import { decodeInlineReferenceUrl } from '../../ai/public/inline-reference-codec';
import { navigateToReference } from '../../ai/public/navigate-to-reference';
import { resolveMolecularReference } from '../../../shared/molecular-reference';
import { molecularDocumentReferenceRecord } from '../../../shared/molecular-document-reference';

export function savedMolecularViewReferenceIdFromHref(
  href: string | null | undefined
): string | null {
  if (!href) return null;
  const parsed = decodeInlineReferenceUrl(href);
  return parsed.ok && parsed.declaration.kind === 'existing-reference'
    ? parsed.declaration.referenceId
    : null;
}

export async function openSavedMolecularViewLink(href: string, notebookPageId: string) {
  const parsed = decodeInlineReferenceUrl(href);
  if (parsed.ok && parsed.declaration.kind === 'molecular-document')
    return navigateToReference(
      molecularDocumentReferenceRecord(parsed.declaration.document, 'Molecular document'),
      { sourceNotebookPageId: notebookPageId }
    );
  const id = savedMolecularViewReferenceIdFromHref(href);
  if (!id) throw new Error('This molecular view link is invalid.');
  const reference = await getEntityReference(id);
  if (!reference) throw new Error('This saved molecular view no longer exists on this device.');
  const subject = resolveMolecularReference(reference);
  if (
    !subject ||
    subject.kind === 'structure' ||
    (subject.kind === 'selection' && !subject.target)
  ) {
    throw new Error('This reference does not contain a saved molecular view.');
  }
  return navigateToReference(reference, { sourceNotebookPageId: notebookPageId });
}

export async function openNotebookReferenceLink(href: string, notebookPageId: string) {
  const id = savedMolecularViewReferenceIdFromHref(href);
  if (!id) throw new Error('This notebook reference is invalid.');
  const reference = await getEntityReference(id);
  if (!reference) throw new Error('This notebook reference no longer exists on this device.');
  return navigateToReference(reference, { sourceNotebookPageId: notebookPageId });
}
