export function isDesktopRuntime(): boolean {
  return isElectron();
}

export function isElectron(): boolean {
  return typeof window !== 'undefined' && 'electronAPI' in window;
}

export function isHostedBrowserRuntime(): boolean {
  if (import.meta.env.MODE === 'hosted') return true;
  if (typeof document === 'undefined') return false;
  return (
    document.documentElement.dataset.dnaforgeRuntime === 'hosted-browser' ||
    document.documentElement.getAttribute('data-dnaforge-runtime') === 'hosted-browser'
  );
}

export function isBrowserOnly(): boolean {
  return !isDesktopRuntime() && !isHostedBrowserRuntime();
}
