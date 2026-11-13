import { useMemo, useState } from 'react';
import { userMessage } from '@waypoint/user-messages';
import { reportErrorForDisplay } from './error-details';

export type StartupStage = 'fonts' | 'platform' | 'listeners' | 'shell' | 'workspace';
export type StartupRuntime = 'desktop' | 'hosted-browser';

const stageLabels: Record<StartupStage, string> = {
  fonts: 'Preparing the sequence display',
  platform: 'Connecting to the desktop',
  listeners: 'Preparing save and application services',
  shell: 'Preparing the application',
  workspace: 'Restoring your workspace',
};

const stageHeadings: Record<StartupStage, string> = {
  fonts: "DNAForge couldn't start",
  platform: "DNAForge couldn't start",
  listeners: "DNAForge couldn't start",
  shell: 'Something went wrong',
  workspace: "Couldn't open your project",
};

const stageGuidance: Record<StartupStage, string> = {
  fonts: "The sequence display font didn't load. Reload to try again.",
  platform: "It couldn't connect to the desktop app. Reload to try again.",
  listeners: "It couldn't prepare its save services. Reload to try again.",
  shell: "This window couldn't be shown. Reload to try again; unsaved changes are saved first.",
  workspace: 'Something went wrong while loading it. Reload to try again.',
};

async function saveThenReload(): Promise<void> {
  try {
    const { saveAllUnsavedWork } = await import('../shared/dirty-reporter');
    await saveAllUnsavedWork();
  } catch (error: unknown) {
    console.warn('[StartupSurface] Save before reload failed:', error);
  }
  window.location.reload();
}

export function StartupSurface({
  stage,
  error,
  runtime = 'desktop',
}: {
  stage: StartupStage;
  error?: unknown;
  runtime?: StartupRuntime;
}) {
  const [reloading, setReloading] = useState(false);
  const [copied, setCopied] = useState(false);
  const report = useMemo(
    () => (error ? reportErrorForDisplay(error, `startup ${stage}`) : null),
    [error, stage]
  );
  const stageLabel =
    runtime === 'hosted-browser' && stage === 'platform'
      ? 'Preparing the hosted workspace'
      : stageLabels[stage];
  const guidance =
    runtime === 'hosted-browser' && stage === 'platform'
      ? userMessage('startup.hostedPlatformFailed')
      : stageGuidance[stage];

  return (
    <main
      className="flex h-screen items-center justify-center bg-bg text-fg"
      data-testid="startup-surface"
      data-startup-stage={stage}
      data-startup-runtime={runtime}
    >
      <div className="max-w-lg p-8 text-center" role={error ? 'alert' : 'status'}>
        <h1 className="mb-3 text-lg font-medium">
          {error ? stageHeadings[stage] : 'Starting DNAForge'}
        </h1>
        <p className="text-sm text-fg-muted">{error ? guidance : stageLabel}</p>
        <button
          className={
            error
              ? 'mt-6 rounded bg-accent px-4 py-2 text-sm text-white hover:bg-accent/80 disabled:opacity-60'
              : 'mt-6 rounded border border-border px-4 py-2 text-sm hover:bg-bg-hover disabled:opacity-60'
          }
          disabled={reloading}
          onClick={() => {
            setReloading(true);
            void saveThenReload();
          }}
        >
          Reload
        </button>
        {report && (
          <details className="mt-4 text-xs text-fg-muted">
            <summary className="cursor-pointer select-none hover:text-fg">Show details</summary>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded border border-border p-2 text-left font-mono">
              <dt>Error</dt>
              <dd data-testid="startup-error-summary">{report.summary}</dd>
              <dt>Reference</dt>
              <dd data-testid="startup-error-reference">{report.reference}</dd>
            </dl>
            <button
              className="mt-2 hover:text-fg"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(report.copyText)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? 'Copied' : 'Copy details'}
            </button>
          </details>
        )}
      </div>
    </main>
  );
}
