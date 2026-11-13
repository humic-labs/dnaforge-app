import type { JSONContent } from '@tiptap/core';
import { findWorkspaceRootForPath, getCatalogEntityForFilePath } from '../../db/workspace-catalog';
import { notebookPackageRootForMetaPath } from '../../db/notebook-package';
import { withWorkspaceArtifactOpen } from '../../services/workspace-artifact-open';
import { isWorkspaceMutationBusyError } from '../../services/workspace-mutation-transaction';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { usePageStore } from './store';
import { openDesignDocument } from '../design/public/open-design-document';
import { presentDocument } from '../canvas/public/present-document';
import {
  cancelledDocumentOpen,
  type DocumentOpenResult,
} from '../canvas/public/document-presentation';
import { registerPendingReadableContent } from '../../lib/readable-content-telemetry';
import type { OpenFileDocumentRequest } from '../document-opening/public/types';
import {
  beginTableNotebookReopen,
  confirmTableNotebookReopen,
} from './embeds/table/notebook-observation';
import { beginNotebookReopen, confirmNotebookReopen } from './notebook-workflow';

export async function openWorkspaceDocument(
  request: OpenFileDocumentRequest
): Promise<DocumentOpenResult> {
  const {
    target: { path },
    label,
    signal,
    placement,
  } = request;
  const workspaceRoot = findWorkspaceRootForPath(useWorkspaceStore.getState().folders, path);
  const present = (
    type: 'page' | 'design' | 'text',
    entityId: string,
    title: string,
    recovery = false
  ): DocumentOpenResult => {
    if (signal?.aborted) return cancelledDocumentOpen();
    const result = presentDocument(
      { type, entityId, label: title },
      placement,
      recovery ? 'loading' : 'ready'
    );
    if (result.status === 'presented')
      registerPendingReadableContent({ contentKey: entityId, tabId: result.tabId });
    return result;
  };
  if (signal?.aborted) return cancelledDocumentOpen();
  const tableReopen = beginTableNotebookReopen();
  const notebookReopen = beginNotebookReopen();
  try {
    return await withWorkspaceArtifactOpen<DocumentOpenResult>({
      path,
      workspaceRoot,
      consume: async (resolved, mutationToken) => {
        if (signal?.aborted) return cancelledDocumentOpen();
        if (resolved.artifact.kind === 'notebook') {
          const sourcePreserved = await usePageStore.getState().upsertPageFromArtifact({
            id: resolved.entity.id,
            title: resolved.artifact.title,
            content: resolved.artifact.content as JSONContent,
            workspaceRoot,
            mutationToken,
            authorityFingerprint: resolved.authorityFingerprint,
          });
          const result = present('page', resolved.entity.id, resolved.artifact.title || label);
          confirmNotebookReopen(notebookReopen, {
            pageId: resolved.entity.id,
            workspaceRoot,
            path: notebookPackageRootForMetaPath(path) ?? path,
            authorityFingerprint: resolved.authorityFingerprint,
            created:
              sourcePreserved === true &&
              result.status === 'presented' &&
              result.disposition === 'created' &&
              !usePageStore.getState().dirtyIds.has(resolved.entity.id),
            cancelled: () => signal?.aborted === true,
          });
          await confirmTableNotebookReopen(tableReopen, {
            pageId: resolved.entity.id,
            workspaceRoot,
            path: notebookPackageRootForMetaPath(path) ?? path,
            authorityFingerprint: resolved.authorityFingerprint,
            created:
              sourcePreserved === true &&
              result.status === 'presented' &&
              result.disposition === 'created',
            cancelled: () => signal?.aborted === true,
          });
          return result;
        }
        if (resolved.artifact.kind === 'assembly-design') {
          return openDesignDocument({
            artifact: resolved.artifact,
            entityId: resolved.entity.id,
            label,
            placement,
            signal,
          });
        }
        return present('text', path, label, true);
      },
    });
  } catch (error) {
    if (signal?.aborted) return cancelledDocumentOpen();
    if (isWorkspaceMutationBusyError(error))
      return { status: 'blocked', message: error instanceof Error ? error.message : String(error) };

    console.warn('[openWorkspaceDocument] Failed to resolve workspace artifact file:', error);
    const entity = await getCatalogEntityForFilePath(notebookPackageRootForMetaPath(path) ?? path);
    if (entity?.type === 'notebook') return present('page', entity.id, entity.name || label, true);
    if (entity?.type === 'design') return present('design', entity.id, entity.name || label, true);
    return present('text', path, label, true);
  } finally {
    tableReopen?.dispose();
  }
}
