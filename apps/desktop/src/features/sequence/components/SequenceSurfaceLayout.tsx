import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { MIN_SIDE_SEQUENCE_PANE_WIDTH } from './side-map-pane-width';

interface SequenceSurfaceLayoutProps {
  rootEventHandlers?: HTMLAttributes<HTMLDivElement>;
  mainContent: ReactNode;
  drawerSlot?: ReactNode;
  adaptiveDrawerWidth?: number;
  restrictionDrawer?: ReactNode;
  toolbar: ReactNode;
}

export function SequenceSurfaceLayout({
  rootEventHandlers,
  mainContent,
  drawerSlot,
  adaptiveDrawerWidth,
  restrictionDrawer,
  toolbar,
}: SequenceSurfaceLayoutProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [stackDrawer, setStackDrawer] = useState(false);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || adaptiveDrawerWidth === undefined) {
      setStackDrawer(false);
      return;
    }
    const measure = () =>
      setStackDrawer(root.clientWidth < MIN_SIDE_SEQUENCE_PANE_WIDTH + adaptiveDrawerWidth + 48);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [adaptiveDrawerWidth]);
  return (
    <div
      {...rootEventHandlers}
      ref={rootRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        flexDirection: 'row',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: stackDrawer ? 'column' : 'row',
        }}
      >
        <div
          style={{
            flex: 1,
            minWidth: stackDrawer ? 0 : `min(${MIN_SIDE_SEQUENCE_PANE_WIDTH}px, 100%)`,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {mainContent}
        </div>
        {drawerSlot && (
          <div
            data-testid="sequence-feature-drawer"
            data-layout={stackDrawer ? 'stacked' : 'inline'}
            style={{
              display: 'flex',
              minWidth: 0,
              minHeight: 0,
              flex: stackDrawer ? '0 1 65%' : '0 1 auto',
              ...(stackDrawer ? { width: '100%', overflow: 'hidden' } : {}),
            }}
          >
            {drawerSlot}
          </div>
        )}
      </div>
      {restrictionDrawer}
      {toolbar}
    </div>
  );
}
