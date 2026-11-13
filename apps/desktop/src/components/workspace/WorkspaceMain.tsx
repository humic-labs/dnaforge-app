import type { ReactNode } from 'react';
import { ExplorerWorkspaceSurface } from '../../features/canvas/ExplorerWorkspaceSurface';
import { HomeWorkbench } from '../../features/home/HomeWorkbench';
import type { ComponentProps } from 'react';

type HomeWorkbenchProps = ComponentProps<typeof HomeWorkbench>;

interface WorkspaceMainProps {
  occluded: boolean;
  workspaceTakeoverActive: boolean;
  emptyFilesHomeActive: boolean;
  homeViewActive: boolean;
  homeWorkbenchActive: boolean;
  recentlyEditedReady?: boolean;
  explorerInset: number;
  explorer: ReactNode;
  settings: ReactNode;
  references?: ReactNode;
  featureView?: ReactNode;
  home: Omit<HomeWorkbenchProps, 'mode' | 'recentlyEditedReady'>;
}

export function WorkspaceMain({
  occluded,
  workspaceTakeoverActive,
  emptyFilesHomeActive,
  homeViewActive,
  homeWorkbenchActive,
  recentlyEditedReady = true,
  explorerInset,
  explorer,
  settings,
  references,
  featureView,
  home,
}: WorkspaceMainProps) {
  return (
    <main
      data-testid="workspace-main"
      className={`relative flex-1 overflow-hidden bg-bg flex flex-col ${
        occluded ? 'invisible' : ''
      }`}
    >
      <ExplorerWorkspaceSurface
        occluded={occluded}
        takeoverActive={workspaceTakeoverActive}
        emptyFilesHomeActive={emptyFilesHomeActive}
        explorerInset={explorerInset}
      >
        {explorer}
      </ExplorerWorkspaceSurface>
      {settings}
      {references}
      {featureView}
      {homeWorkbenchActive ? (
        <HomeWorkbench
          mode={homeViewActive ? 'home' : 'files-empty'}
          recentlyEditedReady={recentlyEditedReady}
          {...home}
        />
      ) : null}
    </main>
  );
}
