import { crashReporter } from 'electron';

let localCaptureStarted = false;

export function isLocalNativeCrashCaptureStarted(): boolean {
  return localCaptureStarted;
}

export function startNativeCrashReporter(): void {
  const dsn = (typeof __SENTRY_DSN__ !== 'undefined' && __SENTRY_DSN__) || process.env.SENTRY_DSN;
  if (dsn) return;
  try {
    crashReporter.start({
      productName: 'DNAForge',
      companyName: 'Humic Labs',
      uploadToServer: false,
      ignoreSystemCrashHandler: false,
    });
    localCaptureStarted = true;
  } catch {}
}
