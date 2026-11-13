import { getWorkspaceRootById } from '../../db/workspace-catalog';
import type { PlatformBridge } from '../../platform';
import { waitForWorkspaceReconcileIdle } from '../../services/workspace-reconcile-lifecycle';
import { createBenchlingMigrationWizardBridge } from './platform-adapter';
import type { BenchlingMigrationWizardBridge } from './types';

export function createDesktopBenchlingMigrationWizardBridge(
  platform: PlatformBridge['benchlingMigration'],
  openDialog?: PlatformBridge['dialog']['open']
): BenchlingMigrationWizardBridge {
  return createBenchlingMigrationWizardBridge(platform, {
    openDialog,
    existingWorkspaceReadiness: { getWorkspaceRootById, waitForWorkspaceReconcileIdle },
  });
}
