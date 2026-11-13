import { lazy, Suspense } from 'react';
import type { LoadedViewerProps } from './LoadedViewer';

const LoadedViewer = lazy(async () => {
  const module = await import('./LoadedViewer');
  return { default: module.LoadedViewer };
});

export function LazyLoadedViewer(props: LoadedViewerProps) {
  return (
    <Suspense
      fallback={
        <div
          aria-busy="true"
          data-testid="structure-embed-module-loading"
          className="min-h-[200px] w-full bg-bg-muted"
        />
      }
    >
      <LoadedViewer {...props} />
    </Suspense>
  );
}
