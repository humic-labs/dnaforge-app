export function reportErrorBoundary(error: Error): void {
  const rawName = error?.name || 'Error';
  try {
    (
      window as Window & {
        electronAPI?: {
          reportRendererError?: (payload: {
            errorClass: string;
            source: 'error' | 'unhandledrejection';
          }) => void;
        };
      }
    ).electronAPI?.reportRendererError?.({ errorClass: rawName, source: 'error' });
  } catch {}

  void import('./analytics')
    .then(({ trackRendererEvent }) => {
      trackRendererEvent('error_boundary_triggered', {
        feature_area: 'reliability',
        error_class: toSafeErrorClass(rawName),
        fatal: false,
        handled: true,
      });
    })
    .catch(() => {});
}

export function toSafeErrorClass(name?: string): string {
  const snake = (name || 'Error')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^[^a-z]+/, '')
    .slice(0, 64);
  return snake || 'error';
}
