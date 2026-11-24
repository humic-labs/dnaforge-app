import { AI_ONLY_INPUT } from '../../lib/ai-only-input';
import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useCallback, useEffect } from 'react';
import { platform } from '../../platform';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useCanvasStore } from '../canvas/public';
import {
  DNA_SEQUENCE_IMPORT_FILE_FILTERS,
  WORKSPACE_IMPORT_FILE_FILTERS,
} from '../workspace-loader/public/import-file-filters';
import { useToastStore } from '../../stores/toast-store';
import { buildImportWizardState } from './build-import-wizard-state';
import { runImportFlow } from './run-import-flow';
import { openImportWizard, useImportWizardStore } from './import-wizard-store';
import { summarizeImportResult } from './import-result-summary';
import { associationFamilyForPath } from '../../shared/file-associations';
import { openQuickLookSource } from '../../lib/open-quick-look-source';
import type {
  DnaSequenceImportIntent,
  EntityImportDestination,
  EntityImportRequest,
} from './entity-import-intent';
import { openLimsImportFromSharedPicker } from '../lims/public/lims-import-launch-store';
import { emitLimsRegistryChanged } from '../lims/public/events';
import { isBrowserOnly } from '../../utils/environment';
import { findWorkspaceRootForPath } from '../../db/workspace-catalog';
import { applyLimsImportReview } from '../lims/public/import-review-client';

export interface ImportWizardController {
  openEntityImport: (request: EntityImportRequest) => Promise<void>;
  openProjectImport: (options?: { agentRequested?: boolean }) => Promise<void>;
}

interface ImportPathsLaunch {
  destination?: EntityImportDestination;
  importIntent?: DnaSequenceImportIntent;
  agentRequested?: boolean;
}

export function useImportWizard(): ImportWizardController {
  const folders = useWorkspaceStore((s) => s.folders);
  const selectedPath = useWorkspaceStore((s) => s.selectedPath);

  const importPaths = useCallback(
    async (paths: string[], launch: ImportPathsLaunch = {}) => {
      if (paths.length === 0) return;

      const activeRequest = useImportWizardStore.getState().request;
      if (activeRequest) {
        const addedState = await buildImportWizardState(paths, {
          folders,
          selectedPath: null,
          forceExplicitDestination: true,
          importIntent: activeRequest.initial.importIntent,
          stat: (p) => platform().fs.stat(p),
          readText: (p) => platform().fs.readTextFile(p),
          previewDedup: (req) => platform().workspace.previewImportDedup(req),
          previewSequenceImport: (sourcePath) =>
            platform().workspace.previewSequenceImport({ sourcePath }),
        });
        if (useImportWizardStore.getState().request !== activeRequest) return;
        window.dispatchEvent(
          new CustomEvent('waypoint:import-wizard-add-items', {
            detail: { requestId: activeRequest.id, items: addedState.items },
          })
        );
        return;
      }

      await runImportFlow(paths, {
        buildState: async (p) => ({
          ...(await buildImportWizardState(p, {
            folders,
            selectedPath: launch.destination ? null : selectedPath,
            initialDestinationPath:
              launch.destination?.kind === 'explicit' ? launch.destination.path : null,
            forceExplicitDestination: launch.destination?.kind === 'choose',
            importIntent: launch.importIntent,
            stat: (path) => platform().fs.stat(path),
            readText: (path) => platform().fs.readTextFile(path),
            previewDedup: (req) => platform().workspace.previewImportDedup(req),
            previewSequenceImport: (sourcePath) =>
              platform().workspace.previewSequenceImport({ sourcePath }),
          })),
          agentRequested: launch.agentRequested ?? false,
        }),
        openWizard: openImportWizard,
        execDeps: {
          importRecords: async ({ review, targetRoot }) => {
            const document = await platform().importReview.snapshot(review.id);
            if (document.revision !== review.revision)
              throw new Error('The spreadsheet review changed. Review it again before importing.');
            const workspaceRoot =
              findWorkspaceRootForPath(useWorkspaceStore.getState().folders, targetRoot) ??
              targetRoot;
            let applied: Awaited<ReturnType<typeof applyLimsImportReview>>;
            try {
              applied = await applyLimsImportReview(
                { ...document.plan, review },
                workspaceRoot,
                targetRoot
              );
            } catch (error) {
              applied = await platform().importReview.snapshot(review.id);
              if (!applied.receipt) throw error;
            }
            if (!applied.receipt)
              throw new Error('The native spreadsheet import did not return an outcome.');
            return { workspaceRoot: applied.workspaceRoot, receipt: applied.receipt };
          },
          importFile: (r) => platform().workspace.importFile(r),
          importFolder: (r) => platform().workspace.importFolder(r),
          importManaged: (r) => platform().workspace.importManaged({ sourcePath: r.sourcePath }),
          importFileAsNewWorkspace: (r) => platform().workspace.importFileAsNewWorkspace(r),
          createEmptyWorkspace: (r) => platform().workspace.createEmptyWorkspace(r),
          registerImportedSequence: (r) => platform().workspace.registerImportedSequence(r),
        },

        onComplete: (result) => {
          const { message, type } = summarizeImportResult(result);
          useToastStore
            .getState()
            .addToast(toUserMessage(message), { definition: 'file-import-result', variant: type });
          if (launch.importIntent?.entityType === 'dna-sequences' || result.registryChanged) {
            emitLimsRegistryChanged();
          }

          const mounted = [
            ...useWorkspaceStore.getState().folders,
            ...(result.createdNewWorkspace && result.workspaceRoot
              ? [{ path: result.workspaceRoot }]
              : []),
          ];

          const owningRoot = (path: string): string =>
            findWorkspaceRootForPath(mounted, path) ?? path;
          const primary = result.workspaceRoot ? owningRoot(result.workspaceRoot) : null;
          const destinations = result.touchedRoots?.length
            ? result.touchedRoots
            : primary
              ? [primary]
              : [];
          const roots = [...new Set(destinations.map(owningRoot))];
          if (primary) {
            window.dispatchEvent(
              new CustomEvent('waypoint:workspace-files-changed', {
                detail: {
                  workspaceRoot: primary,
                  workspaceRoots: roots,
                  createdNewWorkspace: result.createdNewWorkspace ?? false,
                  createdWorkspaceName: result.createdWorkspaceName ?? null,
                  revealPaths: result.written.map((written) => written.destPath),
                },
              })
            );
          }
        },

        onAgentFile: (paths) => attachImportedFilesToChat(paths),
      });
    },
    [folders, selectedPath]
  );

  const openEntityImport = useCallback(
    async (request: EntityImportRequest) => {
      if (
        request.entityType === 'primers' ||
        request.entityType === 'dna-oligos' ||
        request.entityType === 'rna-oligos'
      ) {
        openLimsImportFromSharedPicker(
          request.entityType === 'rna-oligos' ? 'rna_oligo' : 'oligo',
          request.destination.kind === 'explicit' ? request.destination.path : null
        );
        return;
      }
      if (request.entityType === 'strains') {
        openLimsImportFromSharedPicker(
          'strain',
          request.destination.kind === 'explicit' ? request.destination.path : null
        );
        return;
      }
      if (request.entityType === 'proteins') {
        openLimsImportFromSharedPicker(
          'protein',
          request.destination.kind === 'explicit' ? request.destination.path : null
        );
        return;
      }
      if (request.entityType === 'registry-types') {
        openLimsImportFromSharedPicker(
          null,
          request.destination.kind === 'explicit' ? request.destination.path : null
        );
        return;
      }
      if (isBrowserOnly()) {
        useToastStore
          .getState()
          .addToast(userMessage('notice.file-import-is-available-in-the-desktop-app'), {
            definition: 'use-import-wizard-file-import-is-available-in-the-desktop-app',
          });
        return;
      }
      const picked = await platform().dialog.open({
        multiple: true,
        title: 'Import DNA sequences',
        filters: DNA_SEQUENCE_IMPORT_FILE_FILTERS,
      });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      await importPaths(paths, {
        destination: request.destination,
        importIntent: { entityType: 'dna-sequences' },
      });
    },
    [folders, importPaths, selectedPath]
  );

  const openProjectImport = useCallback(
    async (options: { agentRequested?: boolean } = {}) => {
      if (isBrowserOnly()) {
        useToastStore
          .getState()
          .addToast(userMessage('notice.project-import-is-available-in-the-desktop-app'), {
            definition: 'use-import-wizard-project-import-is-available-in-the-desktop-app',
          });
        return;
      }
      const agentRequested = options.agentRequested ?? false;
      const picked = await platform().dialog.open({
        ...(agentRequested
          ? {
              fileOrDirectory: true,
              filters: [{ name: 'Zipped folders', extensions: ['zip'] }],
            }
          : { directory: true }),
        multiple: false,
        title: agentRequested
          ? 'Choose a project folder or ZIP for the agent to organize'
          : 'Import a project',
      });
      if (typeof picked !== 'string') return;
      await importPaths([picked], { agentRequested });
    },
    [importPaths]
  );

  const handleUnclaimedDropPaths = useCallback(
    async (paths: string[]): Promise<void> => {
      if (paths.length === 1) {
        const family = associationFamilyForPath(paths[0]);
        if (family) {
          await openQuickLookSource({
            sourcePath: paths[0],
            familyId: family.id,
            sourceSurface: 'unknown',
          });
          return;
        }
      }
      await importPaths(paths);
    },
    [importPaths]
  );

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.defaultPrevented) return;
      const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];

      if (files.length > 0) e.preventDefault();
      const paths = files
        .map((f) => platform().workspace.getPathForFile(f))
        .filter((p): p is string => Boolean(p));
      if (paths.length > 0) void handleUnclaimedDropPaths(paths);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleUnclaimedDropPaths]);

  useEffect(() => {
    const bridge = (window as Window & { __test?: Record<string, unknown> }).__test;
    if (!bridge) return;
    bridge.triggerImportWizard = (paths: string[]) => importPaths(paths);
    bridge.triggerUnclaimedFileDrop = (paths: string[]) => handleUnclaimedDropPaths(paths);
    bridge.triggerTypedDnaImport = (paths: string[], destinationPath: string) =>
      importPaths(paths, {
        destination: { kind: 'explicit', path: destinationPath },
        importIntent: { entityType: 'dna-sequences' },
      });
    return () => {
      delete bridge.triggerImportWizard;
      delete bridge.triggerUnclaimedFileDrop;
      delete bridge.triggerTypedDnaImport;
    };
  }, [handleUnclaimedDropPaths, importPaths]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const bridge = (window as Window & { __test?: Record<string, unknown> }).__test;
    if (!bridge) return;
    bridge.tabularImportShowcase = async () => {
      const { runTabularShowcase } = await import('./tabular-showcase-dev');
      void runTabularShowcase();
    };
    bridge.registryEntityCount = async () => {
      const counts = await platform().lims.countEntitiesByKind();
      return Object.values(counts).reduce((sum, n) => sum + (n as number), 0);
    };
    return () => {
      delete bridge.tabularImportShowcase;
      delete bridge.registryEntityCount;
    };
  }, []);

  useEffect(() => {
    const p = platform();
    if (AI_ONLY_INPUT) return;
    const offFiles = p.on('menu:import-files', () => {
      void (async () => {
        const picked = await p.dialog.open({
          multiple: true,
          filters: WORKSPACE_IMPORT_FILE_FILTERS,
        });
        const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
        void importPaths(paths);
      })();
    });
    const offFolder = p.on('menu:import-folder', () => {
      void (async () => {
        const picked = await p.dialog.open({ directory: true });
        void importPaths(typeof picked === 'string' ? [picked] : []);
      })();
    });
    const offRegistryRecords = p.on('menu:import-registry-records', () => {
      openLimsImportFromSharedPicker(null, null);
    });
    return () => {
      offFiles();
      offFolder();
      offRegistryRecords();
    };
  }, [importPaths]);

  return { openEntityImport, openProjectImport };
}

function attachImportedFilesToChat(paths: string[]): void {
  useCanvasStore.getState().openChatTab();

  let attempts = 0;
  const tryAttach = () => {
    const zone = document.querySelector('[data-chat-drop-zone]');
    if (!zone) {
      if (attempts++ < 30) requestAnimationFrame(tryAttach);
      return;
    }
    for (const path of paths) {
      zone.dispatchEvent(
        new CustomEvent('waypoint-file-drop', {
          bubbles: false,
          detail: { path, name: path.split('/').pop() ?? path },
        })
      );
    }
  };
  requestAnimationFrame(tryAttach);
}
