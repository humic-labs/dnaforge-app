type RendererErrorSource = 'error' | 'unhandledrejection';

const MAX_REPORTS = 25;

interface ReporterBridge {
  reportRendererError?: (payload: { errorClass: string; source: RendererErrorSource }) => void;
}

export function installRendererErrorReporter(target: Window = window): () => void {
  const reported = new Set<string>();

  const report = (errorClass: string, source: RendererErrorSource): void => {
    const key = `${source}:${errorClass}`;
    if (reported.has(key) || reported.size >= MAX_REPORTS) return;
    reported.add(key);
    try {
      (target as Window & { electronAPI?: ReporterBridge }).electronAPI?.reportRendererError?.({
        errorClass,
        source,
      });
    } catch {}
  };

  const onError = (event: ErrorEvent): void => {
    report(event.error?.name || 'Error', 'error');
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    const reason = event.reason as { name?: string } | string | undefined;
    const cls =
      (reason && typeof reason === 'object' && reason.name) ||
      (typeof reason === 'string' ? 'string' : typeof reason);
    report(String(cls || 'UnhandledRejection'), 'unhandledrejection');
  };

  target.addEventListener('error', onError as EventListener);
  target.addEventListener('unhandledrejection', onRejection as EventListener);

  return () => {
    target.removeEventListener('error', onError as EventListener);
    target.removeEventListener('unhandledrejection', onRejection as EventListener);
  };
}
