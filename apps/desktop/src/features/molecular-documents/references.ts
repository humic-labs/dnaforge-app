import { platform } from '../../platform';
import type { DBEntityReference } from '../../db/entity-references';
import { resolveEntityReferenceIconContext } from '../../services/entity-reference-presentation';
import {
  getCurrentMolecularDocumentFiles,
  getWorkspaceRootById,
  getWorkspaceRootByScope,
  resolveWorkspaceScope,
} from '../../db/workspace-catalog';
import { getEntityReference } from '../../db/entity-references';
import { savedReferenceIdFromHref } from '../../shared/saved-reference-url';
import {
  molecularDocumentCatalogId,
  molecularDocumentReferenceFor,
  molecularDocumentReferenceSchema,
  molecularDocumentReferenceFromHref,
  molecularDocumentReferenceRecord,
  molecularDocumentRevision,
  molecularDocumentRevisionDigest,
  type MolecularDocumentReference,
} from '../../shared/molecular-document-reference';
import { resolveMolecularReference } from '../../shared/molecular-reference';
import { molecularReferenceSnapshotIndex } from '../../shared/molecular-reference';
import { stripWorkspaceScope, WORKSPACE_SCOPE_SEP } from '../../shared/workspace-scoped-identity';
import type { MolecularView } from '../../shared/molecular-view';
import type { MolecularDocument, SavedMolecularDocument } from '../../shared/molecular-document';
import { molViewSpecColorGroups } from '../page/public/embeds/structure3d/molstar/molViewSpecLegend';

export interface MolecularDocumentResolution {
  saved: SavedMolecularDocument;
  documentReference: MolecularDocumentReference;
  snapshot: MolecularView;
  catalogEntityId: string;
}

export async function molecularDocumentReferenceForFile(
  workspaceRoot: string,
  document: MolecularDocument
): Promise<MolecularDocumentReference> {
  const projectId = await resolveWorkspaceScope(workspaceRoot);
  if (!projectId) throw new Error('The molecular document project identity is unavailable.');
  return molecularDocumentReferenceFor(projectId, document);
}

async function documentFiles(projectId?: string, documentId?: string) {
  let files = await getCurrentMolecularDocumentFiles(projectId);
  if (
    projectId &&
    (!files.length ||
      (documentId &&
        !files.some(
          (file) => file.entity_id === `${projectId}${WORKSPACE_SCOPE_SEP}${documentId}`
        )))
  ) {
    const root = await getWorkspaceRootByScope(projectId);
    if (root) {
      await (
        await import('../../db/entity-substrate/reconcile-entities')
      ).reconcileWorkspaceEntities(root);
      files = await getCurrentMolecularDocumentFiles(projectId);
    }
  }
  return files;
}

export function molecularProjectFromOwner(owner?: string): string | undefined {
  if (!owner) return undefined;
  const raw = stripWorkspaceScope(owner);
  return raw === owner ? undefined : owner.slice(0, -raw.length - WORKSPACE_SCOPE_SEP.length);
}

export async function resolveMolecularDocumentReference(
  reference: MolecularDocumentReference
): Promise<MolecularDocumentResolution> {
  reference = molecularDocumentReferenceSchema.parse(reference);
  const catalogEntityId = molecularDocumentCatalogId(reference);
  const files = (await documentFiles(reference.projectId, reference.documentId)).filter(
    (file) => file.entity_id === catalogEntityId
  );
  if (files.length !== 1)
    throw Error(
      files.length
        ? 'The molecular document has ambiguous file ownership.'
        : 'The molecular document file is unavailable. Reopen its project to rebuild its index.'
    );
  const file = files[0];
  const workspaceRoot = await getWorkspaceRootById(file.workspace_id);
  if (!workspaceRoot || (await resolveWorkspaceScope(workspaceRoot)) !== reference.projectId)
    throw Error(
      'The molecular document project identity is unavailable or disagrees with its reference.'
    );
  const saved = await platform().molecularDocuments.read({ path: file.path, workspaceRoot });
  if (saved.document.id !== reference.documentId)
    throw Error('The molecular document file contains a different document identity.');
  const snapshot = molecularDocumentRevision(saved.document, reference.revisionId);
  if ((await molecularDocumentRevisionDigest(snapshot)) !== reference.revisionSha256)
    throw Error('The molecular document revision differs from the exact referenced content.');
  if (reference.viewId) molecularReferenceSnapshotIndex(snapshot, { viewId: reference.viewId });
  if (
    reference.groupId &&
    (!reference.viewId ||
      !molViewSpecColorGroups(
        snapshot.scene,
        molecularReferenceSnapshotIndex(snapshot, { viewId: reference.viewId })
      ).some((group) => group.id === reference.groupId && group.selectable))
  )
    throw Error('The referenced molecular group is unavailable in its exact document view.');
  return { saved, snapshot, documentReference: reference, catalogEntityId };
}

export async function resolveLegacyMolecularDocumentReference(
  reference: DBEntityReference,
  snapshot: MolecularView,
  options: { sourceNotebookPageId?: string; projectId?: string } = {}
): Promise<MolecularDocumentResolution> {
  const projectId =
    options.projectId ??
    molecularProjectFromOwner(options.sourceNotebookPageId) ??
    (reference.workspace_root_path
      ? ((await resolveWorkspaceScope(reference.workspace_root_path)) ?? undefined)
      : undefined);
  const files = await documentFiles(projectId);
  const matches: MolecularDocumentResolution[] = [];
  const expected = await molecularDocumentRevisionDigest(snapshot);
  for (const file of files) {
    const workspaceRoot = await getWorkspaceRootById(file.workspace_id);
    if (!workspaceRoot) continue;
    const saved = await platform().molecularDocuments.read({ path: file.path, workspaceRoot });
    const entry = saved.document.history.find((entry) => entry.referenceId === reference.id);
    if (!entry) continue;
    if ((await molecularDocumentRevisionDigest(entry.snapshot)) !== expected)
      throw Error('A legacy molecular reference disagrees with the immutable document revision.');
    const scope = await resolveWorkspaceScope(workspaceRoot);
    if (!scope) throw Error('The molecular document has no owning project identity.');
    if (file.entity_id !== `${scope}${WORKSPACE_SCOPE_SEP}${saved.document.id}`)
      throw Error('The molecular document catalog identity disagrees with its file.');
    matches.push({
      saved,
      snapshot: entry.snapshot,
      catalogEntityId: file.entity_id,
      documentReference: await molecularDocumentReferenceFor(scope, saved.document, reference.id),
    });
  }
  if (matches.length !== 1)
    throw Error(
      matches.length
        ? 'This legacy molecular reference has ambiguous document ownership. Open the intended document from its project.'
        : 'This legacy molecular view has no verified document owner. Import it as a molecular document before opening it.'
    );
  return matches[0];
}

export { molecularDocumentReferenceRecord };

export async function recoverMolecularDocumentRevision(
  referenceId: string,
  sourceNotebookPageId?: string
): Promise<MolecularDocumentResolution | null> {
  const files = await documentFiles(molecularProjectFromOwner(sourceNotebookPageId));
  const matches: MolecularDocumentResolution[] = [];
  for (const file of files) {
    const root = await getWorkspaceRootById(file.workspace_id);
    if (!root) continue;
    const saved = await platform().molecularDocuments.read({
      path: file.path,
      workspaceRoot: root,
    });
    const entry = saved.document.history.find((entry) => entry.referenceId === referenceId);
    if (!entry) continue;
    const projectId = await resolveWorkspaceScope(root);
    if (!projectId || file.entity_id !== `${projectId}${WORKSPACE_SCOPE_SEP}${saved.document.id}`)
      throw Error('The molecular revision owner disagrees with its file.');
    matches.push({
      saved,
      snapshot: entry.snapshot,
      catalogEntityId: file.entity_id,
      documentReference: await molecularDocumentReferenceFor(
        projectId,
        saved.document,
        referenceId
      ),
    });
  }
  if (matches.length > 1)
    throw Error('This legacy molecular revision has ambiguous document ownership.');
  return matches[0] ?? null;
}

export async function resolveMolecularReferenceRecord(
  href: string,
  label: string,
  sourceNotebookPageId?: string
): Promise<DBEntityReference | null> {
  const document = molecularDocumentReferenceFromHref(href);
  if (document) return molecularDocumentReferenceRecord(document, label);
  const id = savedReferenceIdFromHref(href);
  if (!id) return null;
  const reference = await getEntityReference(id);
  if (reference)
    return { ...reference, iconContext: await resolveEntityReferenceIconContext(reference) };
  const recovered = await recoverMolecularDocumentRevision(id, sourceNotebookPageId);
  return recovered
    ? molecularDocumentReferenceRecord(recovered.documentReference, recovered.snapshot.title)
    : null;
}

export async function resolveMolecularDocumentResult(
  referenceId: string,
  options: { sourceNotebookPageId?: string; projectId?: string } = {}
) {
  const reference = await getEntityReference(referenceId);
  const subject = reference && resolveMolecularReference(reference);
  if (subject?.kind === 'document') return resolveMolecularDocumentReference(subject.document);
  if (reference && subject?.kind === 'visualization' && subject.view)
    return resolveLegacyMolecularDocumentReference(reference, subject.view, options);
  const recovered = await recoverMolecularDocumentRevision(
    referenceId,
    options.sourceNotebookPageId
  );
  if (!recovered)
    throw Error(
      'This molecular result has no verified owning document. Import it as a document first.'
    );
  return recovered;
}

export function isMolecularDocumentResult(reference: DBEntityReference): boolean {
  const subject = resolveMolecularReference(reference);
  return (
    subject?.kind === 'document' ||
    subject?.kind === 'visualization' ||
    subject?.kind === 'view' ||
    Boolean(subject?.kind === 'selection' && subject.target)
  );
}
