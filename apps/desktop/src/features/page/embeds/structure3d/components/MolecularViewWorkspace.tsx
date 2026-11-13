import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import './ColorLegend.css';

interface MolecularViewWorkspaceElements {
  root: HTMLDivElement | null;
  footer: HTMLDivElement | null;
  navigation: HTMLDivElement | null;
  library: HTMLDivElement | null;
  legend: HTMLDivElement | null;
  libraryOpen: boolean;
  setLibraryOpen: (open: boolean) => void;
}
const WorkspaceContext = createContext<MolecularViewWorkspaceElements | null>(null);
export function useMolecularViewWorkspace() {
  return useContext(WorkspaceContext);
}

export function MolecularViewWorkspace({
  children,
  className = '',
  footerPlacement = 'overlay',
}: {
  children: ReactNode;
  className?: string;
  footerPlacement?: 'overlay' | 'inline';
}) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const [navigation, setNavigation] = useState<HTMLDivElement | null>(null);
  const [library, setLibrary] = useState<HTMLDivElement | null>(null);
  const [legend, setLegend] = useState<HTMLDivElement | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const value = useMemo(
    () => ({ root, footer, navigation, library, legend, libraryOpen, setLibraryOpen }),
    [root, footer, navigation, library, legend, libraryOpen]
  );
  return (
    <WorkspaceContext.Provider value={value}>
      <div
        ref={setRoot}
        data-testid="molecular-view-workspace"
        className={`molecular-view-workspace relative flex min-h-0 min-w-0 flex-col ${className}`}
      >
        {children}
        <div
          ref={setFooter}
          data-testid="molecular-view-footer"
          data-placement={footerPlacement}
          data-library-open={libraryOpen ? 'true' : undefined}
          className="molecular-view-footer text-xs"
        >
          <div className="molecular-view-key-body">
            <div ref={setLibrary} data-testid="molecular-view-key-browser" />
            <div
              ref={setLegend}
              data-testid="molecular-view-legend-surface"
              aria-hidden={libraryOpen || undefined}
            />
          </div>
          <div
            ref={setNavigation}
            data-testid="molecular-view-navigation-surface"
            className="molecular-view-key-strip"
          />
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}
