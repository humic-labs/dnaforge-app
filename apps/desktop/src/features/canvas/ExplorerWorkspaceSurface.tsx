import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { WorkspaceVisibilityContext, useWorkspaceVisibility } from './workspace-visibility';

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
  const surfaceRef = useRef<HTMLDivElement>(null);
  const parked = takeoverActive || emptyFilesHomeActive;
  const visible = useWorkspaceVisibility() && !occluded && !parked;
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    if (!visible) {
      surface.setAttribute('inert', '');
    } else {
      surface.removeAttribute('inert');
    }
  }, [visible]);

  return (
    <div
      ref={surfaceRef}
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
      <WorkspaceVisibilityContext.Provider value={visible}>
        {children}
      </WorkspaceVisibilityContext.Provider>
    </div>
  );
}
