import { userMessage } from '@waypoint/user-messages';
import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react';
import type { ActivityView } from '../components/ActivityBar';
import type { BenchlingMigrationHistorySummaryView } from '../shared/benchling-migration-ipc';
import type {
  MigrationSessionOpenEvent,
  MigrationSessionSelectionEvent,
} from '../features/benchling-migration/migration-session-selection';
import type { BenchlingMigrationStatusSnapshot } from '../features/benchling-migration/useBenchlingMigrationStatus';
import type { OpenWorkspaceOptions, WorkspaceSource } from '../features/workspace-loader/types';
import { usePageStore } from '../features/page';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useToastStore } from '../stores/toast-store';
import { platform } from '../platform';
import { isBrowserOnly, isDesktopRuntime } from '../utils/environment';
import { resolveBenchlingMigrationWorkspace } from '../features/benchling-migration/migration-workspace-target';
import {
  buildBenchlingMigrationSettingsView,
  resolveBenchlingMigrationLandingAsset,
} from '../features/benchling-migration';
import { resolveWorkspaceAssetPath } from '../features/workspace-loader/open-workspace-from-source';
import { getCatalogEntityForFilePath } from '../db/workspace-catalog';
import { useLimsOverlayStore } from '../features/lims/lims-overlay-store';
import { openDocument } from '../features/document-opening/open-document';
import { openSequenceFile } from '../features/document-opening/compat';

export type BenchlingWorkspaceActionsOptions = {
  readonly refreshBenchlingMigrationHistory: () => Promise<void>;
  readonly dispatchBenchlingMigrationSession: (event: MigrationSessionSelectionEvent) => void;
  readonly closeBenchlingMigration: () => void;
  readonly clearBenchlingMigrationStatus: () => void;
  readonly openBenchlingMigration: () => void;
  readonly showBenchlingMigration: (event: MigrationSessionOpenEvent) => void;
  readonly benchlingMigrationStatus: BenchlingMigrationStatusSnapshot;
  readonly benchlingMigrationHistory: BenchlingMigrationHistorySummaryView[];
  readonly benchlingMigrationHistoryError: string | null;
  readonly refreshWorkspaceLibrary: () => Promise<void>;
  readonly handleViewChange: (view: ActivityView) => void;
  readonly setProjectHomePath: Dispatch<SetStateAction<string | null>>;
  readonly openWorkspaceSource: (
    source: WorkspaceSource,
    options?: OpenWorkspaceOptions
  ) => Promise<boolean>;
};

export function useBenchlingWorkspaceActions({
  refreshBenchlingMigrationHistory,
  dispatchBenchlingMigrationSession,
  closeBenchlingMigration,
  clearBenchlingMigrationStatus,
  openBenchlingMigration,
  showBenchlingMigration,
  benchlingMigrationStatus,
  benchlingMigrationHistory,
  benchlingMigrationHistoryError,
  refreshWorkspaceLibrary,
  handleViewChange,
  setProjectHomePath,
  openWorkspaceSource,
}: BenchlingWorkspaceActionsOptions) {
  const openActiveBenchlingMigration = useCallback(
    () => showBenchlingMigration({ type: 'active_migration_opened' }),
    [showBenchlingMigration]
  );
  const openBenchlingMigrationHistory = useCallback(
    (runId: string) => showBenchlingMigration({ type: 'history_opened', runId }),
    [showBenchlingMigration]
  );
  const openBenchlingMissingDependencies = useCallback(
    (runId: string) => showBenchlingMigration({ type: 'missing_dependencies_opened', runId }),
    [showBenchlingMigration]
  );
  const handleBenchlingMigrationUnlocked = useCallback(async () => {
    void refreshBenchlingMigrationHistory();
    await usePageStore.getState().refreshNewPages();
    useWorkspaceStore.getState().bumpFileTreeRefresh();
    if (isDesktopRuntime()) await refreshWorkspaceLibrary();
  }, [refreshBenchlingMigrationHistory, refreshWorkspaceLibrary]);

  const handleOpenBenchlingWorkspace = useCallback(
    async (workspaceId: string, sourceIds?: readonly string[]) => {
      if (isBrowserOnly()) {
        dispatchBenchlingMigrationSession({ type: 'workspace_opened' });
        closeBenchlingMigration();
        clearBenchlingMigrationStatus();
        useToastStore.getState().addToast(userMessage('notice.replay-migration-complete'), {
          definition: 'app-replay-migration-complete',
        });
        return;
      }
      await usePageStore.getState().refreshNewPages();
      const migrated = await resolveBenchlingMigrationWorkspace(workspaceId, platform().db);
      if (!migrated) {
        await refreshWorkspaceLibrary();
        useToastStore
          .getState()
          .addToast(userMessage('notice.migration-unlocked-but-its-project-could-not-be-opened'), {
            definition: 'app-migration-unlocked-but-its-project-could-not-be-opened',
          });
        return;
      }
      let openingSourceIds = sourceIds;
      if (!openingSourceIds) {
        const history = await platform().benchlingMigration.getHistory();
        const entry = history.find((item) => item.run.workspaceId === workspaceId);
        if (entry) {
          const detail = await platform().benchlingMigration.getHistoryDetail(entry.run.id);
          if (detail.report?.version === 2)
            openingSourceIds = detail.report.nativeImport?.externalSources.map(
              (source) => source.sourceId
            );
        }
      }
      const landingAsset = await resolveBenchlingMigrationLandingAsset(
        migrated.repoPath,
        (path) => platform().fs.readTextFile(path),
        openingSourceIds
      );
      const landingNotebookEntity =
        landingAsset?.kind === 'notebook'
          ? await getCatalogEntityForFilePath(
              resolveWorkspaceAssetPath(migrated.repoPath, landingAsset.revealRelativePath)
            ).catch((error) => {
              console.warn('[App] Could not resolve validated migration notebook:', error);
              return null;
            })
          : null;
      const opened = await openWorkspaceSource(
        { kind: 'local-folder', path: migrated.repoPath, name: migrated.name },
        {
          inPlace: true,
          replaceCurrent: false,
          makeCurrent: true,
          ...(landingAsset
            ? {
                revealAsset: landingAsset.revealRelativePath,
              }
            : {}),
        }
      );
      if (!opened) return;
      useLimsOverlayStore.getState().setActive(false);
      handleViewChange('files');
      setProjectHomePath(null);
      try {
        if (landingAsset?.kind === 'notebook') {
          if (landingNotebookEntity?.type !== 'notebook') {
            throw new Error('The validated migration notebook is missing from the catalog.');
          }
          await openDocument({
            target: { kind: 'record', tabType: 'page', entityId: landingNotebookEntity.id },
            label: landingNotebookEntity.name || landingAsset.label,
          });
        } else if (landingAsset?.kind === 'sequence') {
          await openSequenceFile({
            filePath: resolveWorkspaceAssetPath(migrated.repoPath, landingAsset.openRelativePath),
            label: landingAsset.label,
            strategy: { kind: 'focused' },
            sourceSurface: 'unknown',
          });
        }
      } catch (error) {
        console.warn('[App] Project opened, but its migration landing document did not:', error);
        useToastStore
          .getState()
          .addToast(
            userMessage('notice.project-opened-but-its-landing-document-could-not-be-opened'),
            {
              definition: 'app-project-opened-but-its-landing-document-could-not-be-opened',
            }
          );
      }
      dispatchBenchlingMigrationSession({ type: 'workspace_opened' });
      closeBenchlingMigration();
      clearBenchlingMigrationStatus();
      useToastStore
        .getState()
        .addToast(userMessage('notice.migration-validated-and-project-opened'), {
          definition: 'app-migration-validated-and-project-opened',
        });
    },
    [
      closeBenchlingMigration,
      clearBenchlingMigrationStatus,
      handleViewChange,
      openWorkspaceSource,
      refreshWorkspaceLibrary,
      dispatchBenchlingMigrationSession,
      setProjectHomePath,
    ]
  );
  const migrationSettings = useMemo(
    () =>
      buildBenchlingMigrationSettingsView({
        snapshot: benchlingMigrationStatus,
        history: benchlingMigrationHistory,
        historyError: benchlingMigrationHistoryError,
        onStart: openBenchlingMigration,
        onOpenActive: openActiveBenchlingMigration,
        onOpenHistory: openBenchlingMigrationHistory,
        onOpenWorkspace: handleOpenBenchlingWorkspace,
        onImportMissingDependencies: openBenchlingMissingDependencies,
      }),
    [
      benchlingMigrationHistory,
      benchlingMigrationHistoryError,
      benchlingMigrationStatus,
      handleOpenBenchlingWorkspace,
      openActiveBenchlingMigration,
      openBenchlingMigration,
      openBenchlingMigrationHistory,
      openBenchlingMissingDependencies,
    ]
  );
  return { handleBenchlingMigrationUnlocked, handleOpenBenchlingWorkspace, migrationSettings };
}
