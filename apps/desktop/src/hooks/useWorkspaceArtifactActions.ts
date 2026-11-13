import { userMessage } from '@waypoint/user-messages';
import { useCallback } from 'react';
import type { WorkspaceCreationContext } from '../components/FileBrowser';
import type {
  ExplorerAssemblyCreateRequest,
  ExplorerEntityCreateRequest,
} from '../components/ExplorerAddPicker';
import type { ActivityView } from '../components/ActivityBar';
import type { CreateDestinationRequest } from '../features/lims/components/RegistryCreateDestinationDialog';
import type { WorkspaceFolder } from '../stores/workspaceStore';
import { useCanvasStore } from '../features/canvas';
import { usePageStore } from '../features/page';
import { useDesignStore } from '../features/design';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useToastStore } from '../stores/toast-store';
import { findContainingPathBoundary } from '../shared/path-boundary';
import { soleWritableProjectRoot, writableProjectRoots } from '../shared/project-root-selection';
import { registerContextualCatalogEntity } from '../db/workspace-catalog';
import { createDesignArtifactFile } from '../db/workspace-artifacts';
import { withRendererWorkspaceMutation } from '../services/workspace-mutation-transaction';
import { createWorkspaceNotebook } from '../features/page/public/create-notebook-command';

export type WorkspaceArtifactActionsOptions = {
  readonly folders: WorkspaceFolder[];
  readonly setCreateDestinationRequest: React.Dispatch<
    React.SetStateAction<CreateDestinationRequest | null>
  >;
  readonly reconcileChangedWorkspace: (
    rootPath: string | null | undefined,
    options?: { rejectOnFailure?: boolean }
  ) => Promise<void>;
  readonly handleCreateEntity: (request: ExplorerEntityCreateRequest) => Promise<unknown>;
  readonly handleViewChange: (view: ActivityView) => void;
  readonly workspaceRootFromCreationContext: (
    context: WorkspaceCreationContext | undefined,
    folders: WorkspaceFolder[]
  ) => string | null;
  readonly artifactTitleFromCreationContext: (
    context: WorkspaceCreationContext | undefined,
    noun: 'notebook' | 'design',
    fallback: string
  ) => string;
};

export function useWorkspaceArtifactActions({
  folders,
  setCreateDestinationRequest,
  reconcileChangedWorkspace,
  handleCreateEntity,
  handleViewChange,
  workspaceRootFromCreationContext,
  artifactTitleFromCreationContext,
}: WorkspaceArtifactActionsOptions) {
  const openInFocusedPanel = useCanvasStore((s) => s.openInFocusedPanel);
  const createPage = usePageStore((s) => s.createPage);
  const createDesign = useDesignStore((s) => s.createDesign);
  const createDraftDesign = useDesignStore((s) => s.createDraftDesign);
  const handleNewPage = useCallback(
    async (context?: WorkspaceCreationContext) => {
      const title = artifactTitleFromCreationContext(context, 'notebook', 'Untitled');
      const workspaceRoot = workspaceRootFromCreationContext(context, folders);
      let pageCreated = false;

      try {
        const { artifact } = await createWorkspaceNotebook({
          title,
          workspaceRoot,
          context,
          createPage,
          source: 'file-explorer-new-menu',
          onCreated: (pageId) => {
            pageCreated = true;
            openInFocusedPanel('page', pageId, title);
          },
        });
        if (artifact) {
          void reconcileChangedWorkspace(workspaceRoot);
        }
      } catch (error) {
        console.warn('[App] Failed to create notebook workspace artifact:', error);
        useToastStore
          .getState()
          .addToast(
            pageCreated
              ? userMessage(
                  'notice.the-notebook-was-created-but-its-project-file-could-not-be-created-it-'
                )
              : userMessage('notice.the-notebook-could-not-be-created-try-again'),
            { definition: 'app-the-notebook-could-not-be-created-try-again' }
          );
        if (!pageCreated) throw error;
      }
    },
    [
      artifactTitleFromCreationContext,
      createPage,
      folders,
      openInFocusedPanel,
      reconcileChangedWorkspace,
      workspaceRootFromCreationContext,
    ]
  );

  const handleNewDesign = useCallback(
    async (context?: WorkspaceCreationContext) => {
      const name = artifactTitleFromCreationContext(context, 'design', 'Untitled');
      let designCreated = false;
      try {
        const workspaceRoot = workspaceRootFromCreationContext(context, folders);
        const artifact = await withRendererWorkspaceMutation(
          workspaceRoot,
          async (mutationToken) => {
            const designId = createDesign(name);
            designCreated = true;
            openInFocusedPanel('design', designId, name);
            const entity = await registerContextualCatalogEntity({
              id: designId,
              type: 'design',
              name,
              locator: `entity://design/${designId}`,
              storageType: 'localStorage',
              workspaceRoot,
              context,
              metadata: {
                createdBy: 'file-explorer-new-menu',
                backingStore: 'waypoint-designs',
              },
              mutationToken,
            });
            const design = useDesignStore.getState().designs[designId] ?? null;
            return createDesignArtifactFile({
              entityId: entity.id,
              designId,
              name: design?.name ?? name,
              design,
              fileName: context?.artifactFileName,
              workspaceRoot,
              context,
              mutationToken,
            });
          }
        );
        if (artifact) {
          useWorkspaceStore.getState().bumpFileTreeRefresh();
          void reconcileChangedWorkspace(workspaceRoot).finally(() => {
            useWorkspaceStore.getState().revealPath(artifact.path);
          });
        }
      } catch (error) {
        console.warn('[App] Failed to create design workspace artifact:', error);
        useToastStore
          .getState()
          .addToast(
            designCreated
              ? userMessage(
                  'notice.the-assembly-was-created-but-its-project-file-could-not-be-created-it-'
                )
              : userMessage('notice.the-assembly-could-not-be-created-try-again'),
            { definition: 'app-the-assembly-could-not-be-created-try-again' }
          );
        if (!designCreated) throw error;
      }
    },
    [
      artifactTitleFromCreationContext,
      createDesign,
      folders,
      openInFocusedPanel,
      reconcileChangedWorkspace,
      workspaceRootFromCreationContext,
    ]
  );

  const handleCreateEntityFromUi = useCallback(
    async (request: ExplorerEntityCreateRequest) => {
      if (request.entityType === 'notebook' || request.entityType === 'assembly') {
        if (!request.destinationPath) {
          setCreateDestinationRequest(request);
          return;
        }
        const owner = findContainingPathBoundary(folders, request.destinationPath);
        if (!owner) {
          useToastStore
            .getState()
            .addToast(
              userMessage('notice.choose-a-folder-inside-an-open-project-before-creating'),
              {
                definition: 'app-choose-a-folder-inside-an-open-project-before-creating',
              }
            );
          return;
        }
        const context: WorkspaceCreationContext = {
          targetPath: request.destinationPath,
          targetKind: 'folder',
          parentPath: request.destinationPath,
          workspaceRoot: owner.path,
        };
        if (request.entityType === 'notebook') {
          await handleNewPage(context);
          return;
        }
        await handleNewDesign(context);
        return;
      }
      await handleCreateEntity(request);
    },
    [folders, handleCreateEntity, handleNewDesign, handleNewPage, setCreateDestinationRequest]
  );

  const openAssemblyDraft = useCallback(
    (workspaceRoot: string, destinationPath: string, assemblyMethod: 'gibson' | 'goldengate') => {
      const designId = createDraftDesign('Untitled Assembly', assemblyMethod);
      openInFocusedPanel('design', designId, 'Untitled Assembly', {
        artifactDocument: {
          kind: 'assembly',
          persistence: 'draft',
          workspaceRoot,
          destinationPath,
        },
      });
    },
    [createDraftDesign, openInFocusedPanel]
  );

  const handleCreateAssembly = useCallback(
    (request: ExplorerAssemblyCreateRequest) => {
      const owner = request.destinationPath
        ? findContainingPathBoundary(folders, request.destinationPath)
        : soleWritableProjectRoot(folders);
      if (!request.destinationPath && !owner && writableProjectRoots(folders).length > 1) {
        setCreateDestinationRequest({ ...request, entityType: 'assemblies' });
        return;
      }
      if (!owner || owner.pinned) {
        useToastStore
          .getState()
          .addToast(
            request.destinationPath
              ? userMessage('notice.choose-a-folder-inside-an-open-writable-project')
              : userMessage('notice.open-a-writable-project-before-creating-an-assembly'),
            { definition: 'app-open-a-writable-project-before-creating-an-assembly' }
          );
        return;
      }
      const workspaceRoot = owner.path;
      const destinationPath = request.destinationPath ?? workspaceRoot;
      openAssemblyDraft(
        workspaceRoot,
        destinationPath,
        request.mode === 'schema' ? 'goldengate' : 'gibson'
      );
    },
    [folders, openAssemblyDraft, setCreateDestinationRequest]
  );

  const handleFindInFolder = useCallback(
    (_folderPath: string) => {
      handleViewChange('search');
    },
    [handleViewChange]
  );

  return {
    handleNewPage,
    handleNewDesign,
    handleCreateEntityFromUi,
    handleCreateAssembly,
    handleFindInFolder,
  };
}
