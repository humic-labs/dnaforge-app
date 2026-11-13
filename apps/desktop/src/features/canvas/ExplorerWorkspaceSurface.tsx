import { type ReactNode } from 'react';
import {
  PresentationScopeContext,
  usePresentationSurface,
} from '../../presentation/PresentationSurface';

interface ExplorerWorkspaceSurfaceProps {
  occluded?: boolean;
  takeoverActive: boolean;
  emptyFilesHomeActive: boolean;
  explorerInset: number;
  children: ReactNode;
}

export function ExplorerWorkspaceSurface({
  occluded = false,
  takeoverActive,
  emptyFilesHomeActive,
  explorerInset,
  children,
}: ExplorerWorkspaceSurfaceProps) {
  const parked = takeoverActive || emptyFilesHomeActive;
  const surface = usePresentationSurface({ id: 'workspace', active: !occluded && !parked });
  const visible = surface.visible;

  return (
    <div
      data-presentation-surface={surface.id}
      ref={surface.bindRef}
      data-testid="explorer-workspace-surface"
      aria-hidden={!visible}
      className={`flex flex-col overflow-hidden ${
        takeoverActive
          ? 'absolute top-0 right-0 bottom-0 invisible pointer-events-none'
          : emptyFilesHomeActive
            ? 'relative flex-1 invisible pointer-events-none'
            : 'relative flex-1'
      }`}
      style={{
        left: takeoverActive ? explorerInset : undefined,
        contentVisibility: visible ? undefined : 'hidden',
      }}
    >
      <PresentationScopeContext.Provider value={surface.scope}>
        {children}
      </PresentationScopeContext.Provider>
    </div>
  );
}
