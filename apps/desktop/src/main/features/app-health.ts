import type { BrowserWindow } from 'electron';
import type { MainFeature } from './main-feature';

let installedWindow: BrowserWindow | null = null;
let installTelemetry: ((window: BrowserWindow) => void) | null = null;

async function prepareAppHealth(): Promise<void> {
  const [{ app }, analytics, health, shell, recovery, sentry] = await Promise.all([
    import('electron'),
    import('../analytics'),
    import('../app-health-telemetry'),
    import('../ipc/shell-readiness'),
    import('../renderer-recovery'),
    import('../sentry'),
  ]);
  const startupClock = health.createStartupClock();
  startupClock.appReady();
  app.once('browser-window-created', () => startupClock.windowCreated());
  shell.onShellReady(() => startupClock.shellReady());
  analytics.onAnalyticsIdentity(sentry.setSentryAnalyticsIdentity);
  recovery.onRendererHang(analytics.trackAppHang);
  installTelemetry = (window) =>
    health.installAppHealthTelemetry(() => (window.isDestroyed() ? undefined : window.webContents));
}

export const appHealthFeature: MainFeature = {
  id: 'app-health',
  prepare: prepareAppHealth,
  onMainWindow: (window) => {
    if (installedWindow || !installTelemetry) return;
    installedWindow = window;
    installTelemetry(window);
  },
};
