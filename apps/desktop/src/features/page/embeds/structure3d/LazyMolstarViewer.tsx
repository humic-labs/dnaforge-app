import { lazy, Suspense } from 'react';
import type { MolstarViewerProps } from './MolstarViewer';

const MolstarViewer = lazy(async () => {
  const module = await import('./MolstarViewer');
  return { default: module.MolstarViewer };
});

export function LazyMolstarViewer(props: MolstarViewerProps) {
  return (
    <Suspense
      fallback={
        <div
          aria-busy="true"
          data-testid="molstar-module-loading"
          className="h-full w-full bg-bg-muted"
          style={{ height: props.height }}
        />
      }
    >
      <MolstarViewer {...props} />
    </Suspense>
  );
}
