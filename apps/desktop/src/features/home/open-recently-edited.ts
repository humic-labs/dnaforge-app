import type { RecentlyEditedItem } from './recently-edited';

type RecentWorkspaceSource = { kind: 'local-folder'; path: string };
type RecentWorkspaceOpenOptions = { inPlace: true; telemetrySource: 'recent' };

interface OpenRecentlyEditedDependencies {
  isWorkspaceMounted: (path: string) => boolean;
  mountWorkspace: (
    source: RecentWorkspaceSource,
    options: RecentWorkspaceOpenOptions
  ) => Promise<boolean>;
  openTarget: (item: RecentlyEditedItem) => Promise<boolean>;
}

export async function openRecentlyEditedItem(
  item: RecentlyEditedItem,
  dependencies: OpenRecentlyEditedDependencies
): Promise<boolean> {
  if (item.workspaceRoot && !dependencies.isWorkspaceMounted(item.workspaceRoot)) {
    const mounted = await dependencies.mountWorkspace(
      { kind: 'local-folder', path: item.workspaceRoot },
      { inPlace: true, telemetrySource: 'recent' }
    );
    if (!mounted) return false;
  }

  return dependencies.openTarget(item);
}
