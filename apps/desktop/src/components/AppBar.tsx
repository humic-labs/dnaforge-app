import { toUserMessage, userMessageValue, type UserMessageValue } from '@waypoint/user-messages';
import { useSidecarStatus } from '../hooks/use-sidecar-status';
import { platform } from '../platform';
import { SunIcon, MoonIcon, SparklesIcon } from './icons/glyphs';
import { COMMAND_IDS, useCommandRegistry } from '../commands';
import { shortcutChord } from '../keyboard/shortcutRegistry';
import { formatShortcutHint } from './menuShortcuts';
import { Button } from './ui';
import { FeedbackWidget } from './FeedbackWidget';
import { TelemetryBlockedSurface } from './TelemetryBlockedSurface';
import { useDarkMode } from '../shared/context/DarkModeContext';
import { useEffect, useState } from 'react';
import { SharedProjectShareButton } from '../features/auth/SharedProjectShareButton';
import { SharedProjectStatusChip } from '../features/auth/SharedProjectStatusChip';
import { ApplicationTopBar } from './ApplicationTopBar';
import type { ReactNode } from 'react';
import { WindowsMenuBar } from './WindowsMenuBar';

interface AppBarProps {
  appVersion: string;
  extraControls?: ReactNode;
}

export function AppBar({ appVersion, extraControls }: AppBarProps) {
  const { dispatchCommand } = useCommandRegistry();
  const desktopApi = typeof window !== 'undefined' ? window.electronAPI : undefined;
  const windowsTitleBar =
    desktopApi !== undefined && 'platform' in desktopApi && desktopApi.platform === 'win32';
  const { darkMode, toggleDarkMode } = useDarkMode();
  const [restartPending, setRestartPending] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [nonReleaseUserDataPath, setNonReleaseUserDataPath] = useState<string | null>(null);
  const askAiShortcut: UserMessageValue =
    formatShortcutHint(shortcutChord('app.ai-chat')) ?? userMessageValue('Ctrl+/');
  const sidecarStatus = useSidecarStatus('');
  const sidecarStarting = sidecarStatus === 'starting' || sidecarStatus === 'restarting';
  const sidecarRecoverable =
    sidecarStatus === 'error' || sidecarStatus === 'timeout' || sidecarStatus === 'stopped';

  useEffect(() => {
    if (windowsTitleBar) {
      void platform()
        .window.setTitleBarTheme(darkMode)
        .catch((error: unknown) => {
          console.warn('Could not update window controls theme', error);
        });
    }
  }, [windowsTitleBar, darkMode]);

  useEffect(() => {
    let active = true;
    void platform()
      .runtime.getProvenance()
      .then((provenance) => {
        if (
          active &&
          provenance.kind === 'electron-main' &&
          !provenance.isReleaseBuild &&
          provenance.userDataPath
        ) {
          setNonReleaseUserDataPath(provenance.userDataPath);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const restartSidecar = async () => {
    setRestartPending(true);
    setRestartError(null);
    try {
      await platform().config.restartSidecar();
    } catch (err) {
      setRestartError(toUserMessage(err, 'failure.restart-failed'));
    } finally {
      setRestartPending(false);
    }
  };

  return (
    <ApplicationTopBar
      windowControlsInset
      windowsTitleBar={windowsTitleBar}
      menus={windowsTitleBar ? <WindowsMenuBar /> : undefined}
      context={
        <>
          {typeof __DEV_BRANCH_LABEL__ === 'string' && __DEV_BRANCH_LABEL__ && (
            <span
              className="text-[10px] font-mono text-fg-subtle bg-bg-muted px-1.5 py-0.5 rounded max-w-[280px] truncate"
              data-testid="appbar-dev-instance-label"
              title={__DEV_BRANCH_LABEL__}
            >
              {__DEV_BRANCH_LABEL__}
            </span>
          )}
          {nonReleaseUserDataPath && (
            <span
              className="ph-no-capture rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning"
              data-testid="appbar-non-release-profile"
              data-analytics-block
              title={`Dev profile (isolated DB). ${typeof __DEV_BRANCH_LABEL__ === 'string' && __DEV_BRANCH_LABEL__ ? __DEV_BRANCH_LABEL__ + ' · ' : ''}Path: ${nonReleaseUserDataPath}`}
            >
              dev
            </span>
          )}
          <SharedProjectStatusChip />
          {!windowsTitleBar && <SharedProjectShareButton />}
          {sidecarStarting && (
            <span className="flex items-center gap-1.5 text-[10px] text-fg-subtle ml-2">
              <span className="w-2.5 h-2.5 border border-fg-subtle border-t-transparent rounded-full animate-spin" />
              {sidecarStatus === 'restarting'
                ? 'Restarting analysis engine...'
                : 'Starting analysis engine...'}
            </span>
          )}
          {sidecarRecoverable && (
            <span
              className="ml-2 inline-flex max-w-[280px] items-center gap-1.5 truncate text-[10px] text-error"
              data-testid="appbar-sidecar-offline"
            >
              <span className="truncate">
                {restartError ? 'Analysis engine restart failed' : 'Analysis engine offline'}
              </span>
              <button
                type="button"
                data-ph-capture-attribute-action="enable"
                data-ph-capture-attribute-surface="header"
                onClick={restartSidecar}
                disabled={restartPending}
                className="inline-flex h-5 flex-shrink-0 items-center rounded border border-error/40 px-1.5 text-[10px] font-medium text-error hover:bg-error/10 disabled:opacity-60"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              >
                {restartPending ? 'Restarting' : 'Restart'}
              </button>
            </span>
          )}
        </>
      }
      controls={
        <>
          {extraControls}
          <div className="flex min-w-0 items-center gap-2" data-testid="appbar-ai-entry">
            <Button
              type="button"
              onClick={() => dispatchCommand(COMMAND_IDS.appFocusCommandInput, { source: 'ui' })}
              variant="appbar"
              title={`Ask AI (${askAiShortcut})`}
              aria-label="Ask AI"
              data-testid="appbar-ask-ai-button"
              data-ph-capture-attribute-action="open"
              data-ph-capture-attribute-surface="header"
            >
              <SparklesIcon size={14} className="text-accent" />
              <span className="appbar-action-label">Ask AI</span>
            </Button>
          </div>
          <TelemetryBlockedSurface className="contents">
            <FeedbackWidget appVersion={appVersion} titleBarInset={windowsTitleBar} />
          </TelemetryBlockedSurface>
          <button
            onClick={toggleDarkMode}
            className={`${windowsTitleBar ? 'p-1' : 'p-1.5'} rounded text-fg-muted hover:text-fg hover:bg-bg-muted transition-colors`}
            title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            data-ph-capture-attribute-action={darkMode ? 'disable' : 'enable'}
            data-ph-capture-attribute-surface="header"
          >
            {darkMode ? <MoonIcon /> : <SunIcon />}
          </button>
        </>
      }
    />
  );
}
