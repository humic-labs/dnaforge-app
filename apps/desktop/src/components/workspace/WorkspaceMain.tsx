import type { ReactNode } from 'react';
import { ExplorerWorkspaceSurface } from '../../features/canvas/ExplorerWorkspaceSurface';
import { HomeWorkbench } from '../../features/home/HomeWorkbench';
import type { ComponentProps } from 'react';
import { PresentationBoundary } from '../../presentation/PresentationSurface';

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
      {settings ? (
        <PresentationBoundary id="settings" focused layout="flex">
          {settings}
        </PresentationBoundary>
      ) : null}
      {references ? (
        <PresentationBoundary id="references" focused layout="flex">
          {references}
        </PresentationBoundary>
      ) : null}
      {featureView ? (
        <PresentationBoundary id="feature-view" focused layout="flex">
          {featureView}
        </PresentationBoundary>
      ) : null}
      {homeWorkbenchActive ? (
        <PresentationBoundary id="home" focused layout="flex">
          <HomeWorkbench
            mode={homeViewActive ? 'home' : 'files-empty'}
            recentlyEditedReady={recentlyEditedReady}
            {...home}
          />
        </PresentationBoundary>
      ) : null}
    </main>
  );
}
