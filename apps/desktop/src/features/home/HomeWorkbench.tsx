import { useEffect } from 'react';
import { HomePanel } from '../../components/HomePanel';
import { refreshRecentlyEdited } from './recently-edited';
import type { ComponentProps } from 'react';

type HomePanelProps = ComponentProps<typeof HomePanel>;

interface HomeWorkbenchProps extends HomePanelProps {
  mode: 'home' | 'files-empty';
  recentlyEditedReady: boolean;
}

export function HomeWorkbench({ mode, recentlyEditedReady, ...panelProps }: HomeWorkbenchProps) {
  useEffect(() => {
    if (!recentlyEditedReady) return;
    void refreshRecentlyEdited(50).catch((error) => {
      console.error('[HomeWorkbench] Failed to load Recently Edited:', error);
    });
  }, [mode, recentlyEditedReady]);

  return (
    <div
      className={
        mode === 'home'
          ? 'relative flex-1 flex min-h-0 flex-col overflow-hidden'
          : 'absolute inset-0 z-10 flex flex-col overflow-hidden'
      }
    >
      <HomePanel {...panelProps} recentlyEditedReady={recentlyEditedReady} />
    </div>
  );
}
