import type { JSONContent } from '@tiptap/core';
import { createEntityReference } from '../../db/entity-references';
import { resolveNotebookArtifactWorkspaceOwner } from '../../db/workspace-artifacts';
import { resolveWorkspaceScope } from '../../db/workspace-catalog';
import { scopedProjectionId } from '../../shared/workspace-scoped-identity';
import { soleWritableProjectRoot, writableProjectRoots } from '../../shared/project-root-selection';
import { getCurrentWorkspaceScope, useWorkspaceStore } from '../../stores/workspaceStore';
import { usePageStore } from './store';
import { molecularViewAttrs, type MolecularView } from './embeds/structure3d/utils/molecularView';
import {
  resolveMolecularDocumentResult,
  resolveMolecularDocumentReference,
} from '../molecular-documents/public/references';
import {
  molecularDocumentReferenceHref,
  molecularDocumentRevisionDigest,
  type MolecularDocumentReference,
} from '../../shared/molecular-document-reference';
import { notebookReferenceFromHref } from '../../shared/notebook-reference-normalization';

interface MolecularNotebookDocumentBinding {
  documentReference: MolecularDocumentReference;
  path: string;
  fileRevision: string;
  currentRevisionId: string;
}

export async function appendMolecularPresentation(
  content: JSONContent,
  referenceId: string,
  view: MolecularView,
  owner: MolecularNotebookDocumentBinding
): Promise<JSONContent> {
  if (
    owner.documentReference.revisionId !== referenceId ||
    (await molecularDocumentRevisionDigest(view)) !== owner.documentReference.revisionSha256
  )
    throw Error('The notebook capture disagrees with its exact molecular document revision.');
  const href = molecularDocumentReferenceHref(owner.documentReference);
  const binding = {
    molecularDocumentReference: owner.documentReference,
    molecularDocumentId: owner.documentReference.documentId,
    molecularDocumentProjectId: owner.documentReference.projectId,
    molecularDocumentPath: owner.path,
    molecularDocumentRevision: owner.fileRevision,
    molecularDocumentSavedReferenceId: owner.currentRevisionId,
    molecularDocumentHistoricalRevisionId:
      referenceId !== owner.currentRevisionId ? referenceId : undefined,
  };
  const children = content.content ?? [];
  if (
    children.some(
      (node) =>
        node.type === 'embed' &&
        node.attrs?.data?.molecularDocumentReference &&
        molecularDocumentReferenceHref(node.attrs.data.molecularDocumentReference) === href
    )
  )
    return content;

  const embedId = `structure3d-${crypto.randomUUID()}`;
  return {
    ...content,
    type: 'doc',
    content: [
      ...children,
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: view.title }] },
      ...(view.caption
        ? [{ type: 'paragraph', content: [{ type: 'text', text: view.caption }] }]
        : []),
      { type: 'paragraph', content: [notebookReferenceFromHref(href, view.title)!] },
      {
        type: 'embed',
        attrs: {
          type: 'structure3d',
          version: 1,
          refId: embedId,
          data: {
            ...molecularViewAttrs(`saved-view:${referenceId}`, view, undefined, referenceId),
            molecularViewSnapshot: view,
            ...binding,
            id: embedId,
          },
        },
      },
      { type: 'paragraph' },
    ],
  };
}

export async function captureMolecularPresentationToNotebook(
  referenceId: string,
  target: {
    pageId?: string;
    newNotebookTitle?: string;
    workspaceRoot?: string;
    documentReference?: MolecularDocumentReference;
  }
) {
  if (Boolean(target.pageId) === Boolean(target.newNotebookTitle?.trim()))
    throw Error('Choose an existing notebook or provide a new notebook title.');
  const document = target.documentReference
    ? await resolveMolecularDocumentReference(target.documentReference)
    : await resolveMolecularDocumentResult(referenceId, { sourceNotebookPageId: target.pageId });
  const view = document.snapshot;
  referenceId = document.documentReference.revisionId;
  await usePageStore.getState().fetchPages();
  let pageId = target.pageId;
  if (!pageId) {
    const roots = writableProjectRoots(useWorkspaceStore.getState().folders);
    const root = target.workspaceRoot
      ? roots.find((root) => root.path === target.workspaceRoot)
      : soleWritableProjectRoot(roots);
    if ((target.workspaceRoot && !root) || (!root && roots.length > 1))
      throw Error('Choose the project for the new notebook, or choose an existing notebook.');
    const scope = await resolveWorkspaceScope(root?.path ?? null);
    pageId = await usePageStore
      .getState()
      .createPage(target.newNotebookTitle!.trim(), scopedProjectionId(scope, crypto.randomUUID()));
  }
  if (usePageStore.getState().dirtyIds.has(pageId))
    throw Error('Save the notebook’s current edits before recording a presentation in it.');
  const page = await usePageStore.getState().fetchPage(pageId);
  if (!page) throw Error('The notebook is unavailable.');
  const content = await appendMolecularPresentation(page.content, referenceId, view, {
    documentReference: document.documentReference,
    path: document.saved.path,
    fileRevision: document.saved.revision,
    currentRevisionId: document.saved.document.currentReferenceId,
  });
  if (content !== page.content) await usePageStore.getState().savePage(pageId, content);
  const owner = await resolveNotebookArtifactWorkspaceOwner(pageId);
  const root = owner.status === 'bound' ? owner.workspaceRoot : null;
  const reference = await createEntityReference({
    entityType: 'notebook',
    displayLabel: page.title,
    locator: `entity://page/${pageId}`,
    deepLinkParams: null,
    data: null,
    source: 'ai',
    workspaceScope: root ? await resolveWorkspaceScope(root) : getCurrentWorkspaceScope(),
    workspaceRootPath: root,
  });
  useWorkspaceStore.getState().bumpFileTreeRefresh();
  return { pageId, title: page.title, reference };
}
