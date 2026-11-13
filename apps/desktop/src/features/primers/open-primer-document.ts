import { findContainingPathBoundary } from '../../shared/path-boundary';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { presentDocument } from '../canvas/public/present-document';
import {
  cancelledDocumentOpen,
  type DocumentOpenResult,
} from '../canvas/public/document-presentation';
import type { OpenFileDocumentRequest } from '../document-opening/public/types';
import {
  listProjectEditFolders,
  mergeProjectEditFolders,
  projectPathIsReadOnly,
} from '../workspace-loader/public/project-edit-folders';

export async function openPrimerDocument(
  request: OpenFileDocumentRequest
): Promise<DocumentOpenResult> {
  const {
    target: { path },
    label,
    placement,
    signal,
  } = request;
  if (signal?.aborted) return cancelledDocumentOpen();
  const registered = await listProjectEditFolders();
  if (signal?.aborted) return cancelledDocumentOpen();
  const folders = mergeProjectEditFolders(registered, useWorkspaceStore.getState().folders);
  const owner = findContainingPathBoundary(folders, path);
  if (!owner)
    return {
      status: 'blocked',
      message: 'Open the project that owns this primer before editing it.',
    };
  const lastSeparator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const destinationPath = lastSeparator > 0 ? path.slice(0, lastSeparator) : owner.path;
  return presentDocument(
    {
      type: 'primer',
      entityId: path,
      readOnly: projectPathIsReadOnly(path, folders),
      label: label.replace(/\.primer\.json$/i, ''),
      artifactDocument: {
        kind: 'primer',
        persistence: 'persisted',
        workspaceRoot: owner.path,
        destinationPath,
        artifactPath: path,
      },
    },
    placement
  );
}
