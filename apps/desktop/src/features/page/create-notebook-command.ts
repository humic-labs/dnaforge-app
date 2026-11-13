import { isElectron } from '../../utils/environment';
import { platform } from '../../platform';
import { waitForNativeFileDocumentReadiness } from '../workspace/public/file-document-client';
import type { WorkspaceCreationContext } from '../../components/FileBrowser';
import { resolveWorkspaceScope, registerContextualCatalogEntity } from '../../db/workspace-catalog';
import { createNotebookArtifactFile } from '../../db/workspace-artifacts';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { scopedProjectionId } from '../../shared/workspace-scoped-identity';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { usePageStore } from './store';

export class NotebookCreationError extends Error {
  constructor(
    message: string,
    readonly pageId: string | null
  ) {
    super(message);
  }
}

export async function createWorkspaceNotebook(input: {
  title: string;
  workspaceRoot: string | null;
  context?: WorkspaceCreationContext;
  source: 'file-explorer-new-menu' | 'agent';
  createPage?: ReturnType<typeof usePageStore.getState>['createPage'];
  onCreated?: (pageId: string) => void;
}) {
  let createdPageId: string | null = null;
  try {
    if (isElectron()) {
      await waitForNativeFileDocumentReadiness();
      const workspaceRoot = input.context?.workspaceRoot ?? input.workspaceRoot;
      if (!workspaceRoot)
        throw new NotebookCreationError('Choose the writable project for this notebook.', null);
      const result = await platform().notebook.create({
        title: input.title,
        workspaceRoot,
        context: input.context,
        requestId: crypto.randomUUID(),
      });
      if (result.status === 'failed') {
        const effect = result.partialEffects.find(
          (value) => value && typeof value === 'object' && 'pageId' in value
        ) as { pageId?: unknown } | undefined;
        const id = typeof effect?.pageId === 'string' ? effect.pageId : null;
        if (id) {
          const page = await usePageStore.getState().fetchPage(id);
          if (page) {
            createdPageId = id;
            input.onCreated?.(id);
          }
        }
        throw new NotebookCreationError(result.message, createdPageId);
      }
      const snapshot = result.snapshot;
      createdPageId = snapshot.pageId;
      await usePageStore.getState().fetchPage(snapshot.pageId);
      input.onCreated?.(snapshot.pageId);
      useWorkspaceStore.getState().bumpFileTreeRefresh();
      return {
        pageId: snapshot.pageId,
        artifact: {
          path: snapshot.path,
          name: snapshot.path.split(/[\\/]/).pop() ?? snapshot.title,
          fileKind: 'waypoint-notebook',
          sizeBytes: snapshot.sizeBytes ?? 0,
          authorityFingerprint: snapshot.canonicalFingerprint,
        },
      };
    }
    const scope = await resolveWorkspaceScope(input.workspaceRoot);
    const pageId = scopedProjectionId(scope, crypto.randomUUID());
    const artifact = await withRendererWorkspaceMutation(
      input.workspaceRoot,
      async (mutationToken) => {
        let entityId = pageId;
        try {
          const entity = await registerContextualCatalogEntity({
            id: pageId,
            type: 'notebook',
            name: input.title,
            locator: `entity://page/${pageId}`,
            storageType: 'database',
            workspaceRoot: input.workspaceRoot,
            context: input.context,
            metadata: { createdBy: input.source, backingStore: 'pages' },
            mutationToken,
          });
          entityId = entity.id;
        } catch (error) {
          console.warn('[Notebook] Catalog registration failed; writing native package:', error);
        }
        const artifact = await createNotebookArtifactFile({
          entityId,
          pageId,
          title: input.title,
          fileName: input.context?.artifactFileName,
          workspaceRoot: input.workspaceRoot,
          context: input.context,
          mutationToken,
        });
        if (!artifact)
          throw new Error('The notebook package could not be published to its project.');
        await (input.createPage ?? usePageStore.getState().createPage)(
          input.title,
          pageId,
          mutationToken
        );
        createdPageId = pageId;
        input.onCreated?.(pageId);
        return artifact;
      }
    );
    if (artifact) useWorkspaceStore.getState().bumpFileTreeRefresh();
    return { pageId, artifact };
  } catch (cause) {
    throw new NotebookCreationError(
      cause instanceof Error ? cause.message : String(cause),
      createdPageId
    );
  }
}
