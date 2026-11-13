import { userMessage } from '@waypoint/user-messages';
import { useEffect, useState, type Ref } from 'react';
import { DESKTOP_ANALYTICS_DISCLOSURE } from '@waypoint/analytics-policy';
import {
  readUsageAnalyticsChoice,
  setUsageAnalyticsChoice,
  USAGE_ANALYTICS_CHOICE_CHANGED_EVENT,
} from '../lib/usage-analytics-setting-source';
import { APP_BUILD } from '../lib/app-build';
import { getReleaseNote } from '../lib/release-notes';
import {
  appBuildLabel,
  appBuildKindLabel,
  installedReleaseVersion,
} from '../shared/app-build-identity';
import { OpenSourceLicensesSetting } from './OpenSourceLicenses';
import { settingsRowProps } from './settings-catalog';
import {
  SettingsSection,
  SettingsToggle,
  SETTINGS_SECONDARY_BUTTON_CLASS,
} from './SettingsSubsection';

export function UsageAnalyticsSetting() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      readUsageAnalyticsChoice()
        .then((choice) => {
          if (!cancelled) setEnabled(choice);
        })
        .catch(() => {
          if (!cancelled) setEnabled(null);
        });
    };
    refresh();
    window.addEventListener(USAGE_ANALYTICS_CHOICE_CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(USAGE_ANALYTICS_CHOICE_CHANGED_EVENT, refresh);
    };
  }, []);

  const change = (next: boolean) => {
    setPending(true);
    setEnabled(next);
    setUsageAnalyticsChoice(next)
      .catch((error) => {
        console.error('[Analytics] Privacy setting failed:', error);
        return readUsageAnalyticsChoice().then(setEnabled);
      })
      .catch(() => setEnabled(null))
      .finally(() => setPending(false));
  };

  return (
    <div data-testid="settings-usage-analytics">
      <SettingsToggle
        {...settingsRowProps('usage-analytics')}
        checked={enabled === true}
        onChange={change}
        disabled={enabled === null || pending}
        disabledReason={enabled === null ? userMessage('settings.unavailableHere') : undefined}
      />
      <p className="max-w-2xl text-xs leading-5 text-fg-muted">{DESKTOP_ANALYTICS_DISCLOSURE}</p>
    </div>
  );
}

export function AboutSettingsSection({
  onOpenReleaseNotes,
  sectionRef,
}: {
  onOpenReleaseNotes?: (sourceElement?: HTMLElement) => void;
  sectionRef?: Ref<HTMLDivElement>;
}) {
  const installedVersion = installedReleaseVersion(APP_BUILD);
  const currentNote = installedVersion ? getReleaseNote(installedVersion) : null;
  return (
    <SettingsSection
      id="settings-about"
      title="About"
      testId="settings-section-about"
      sectionRef={sectionRef}
      flushTop
    >
      <div className="space-y-3">
        <div>
          <div className="text-sm font-semibold text-fg">DNAForge</div>
          <div data-testid="settings-about-version" className="text-xs text-fg-muted mt-0.5">
            {appBuildLabel(APP_BUILD)}
          </div>
        </div>
        <div className="text-xs text-fg-subtle" data-testid="settings-about-build-kind">
          {appBuildKindLabel(APP_BUILD)}
        </div>
        <details className="text-xs text-fg-muted">
          <summary className="cursor-pointer text-fg-subtle">Build details</summary>
          <dl className="mt-3 space-y-2">
            {APP_BUILD.sourceCommit && (
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                <dt className="text-fg-subtle">
                  {APP_BUILD.kind === 'development' ? 'Source at startup' : 'Source revision'}
                </dt>
                <dd title={APP_BUILD.sourceCommit} data-testid="settings-about-source">
                  <span className="font-mono">{APP_BUILD.sourceCommit.slice(0, 12)}</span>
                  {APP_BUILD.sourceModified ? ' · with local changes' : ''}
                </dd>
              </div>
            )}
          </dl>
        </details>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-fg-subtle cursor-default opacity-50">GitHub</span>
          <span className="text-border">·</span>
          <span className="text-fg-subtle cursor-default opacity-50">Website</span>
        </div>
      </div>
      <div
        data-settings-target="release-notes"
        tabIndex={-1}
        data-testid="settings-section-release-notes"
        className="flex items-center justify-between gap-3 border-t border-border/30 pt-4"
      >
        <div className="text-xs text-fg-muted">
          {installedVersion ? (
            <>
              Currently running <span className="text-fg font-medium">v{installedVersion}</span>
              {currentNote && (
                <span className="text-fg-subtle"> (released {currentNote.date})</span>
              )}
            </>
          ) : (
            'Browse release notes.'
          )}
        </div>
        <button
          onClick={(event) => onOpenReleaseNotes?.(event.currentTarget)}
          disabled={!onOpenReleaseNotes}
          data-testid="settings-open-release-notes"
          className={SETTINGS_SECONDARY_BUTTON_CLASS}
        >
          View Release Notes →
        </button>
      </div>
      <OpenSourceLicensesSetting />
      <div data-testid="settings-section-privacy" aria-label="Privacy" className="space-y-2">
        <UsageAnalyticsSetting />
        <a
          href="https://dnaforge.com/privacy"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-fg-link hover:underline"
        >
          Read our Privacy Policy
        </a>
      </div>
    </SettingsSection>
  );
}
