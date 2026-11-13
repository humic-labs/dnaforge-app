import { userMessage } from '@waypoint/user-messages';
import { useEffect, type Ref, type ReactNode } from 'react';
import { useDarkMode } from '../shared/context/DarkModeContext';
import { useAssemblyColorSchemeStore } from '../features/design/color-scheme-store';
import {
  ASSEMBLY_COLOR_SCHEME_OPTIONS,
  type AssemblyColorSchemeId,
} from '../features/design/colors';
import {
  useDisplayZoomStore,
  applyZoomLevel,
  setDisplayZoom,
  retryDisplayZoom,
} from '../lib/applyZoomLevel';
import {
  useWebGLPreferenceStore,
  hydrateWebGLPerformancePreference,
  setWebGLPerformancePreference,
  retryWebGLPerformancePreference,
  SEQUENCE_WEBGL_PERFORMANCE_PREFERENCES,
} from '../features/sequence/public/webgl-performance-preference';
import { parseWindowZoomFactor } from '../shared/window-zoom';
import { isDesktopRuntime } from '../utils/environment';
import { SETTINGS_SECTIONS, settingsRowProps } from './settings-catalog';
import {
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSegmentedControl,
  SettingsToggle,
} from './SettingsSubsection';
import type { AppearancePhase } from '../lib/appearance-result';

function AssemblyColorSchemePicker({
  value,
  onChange,
}: {
  value: AssemblyColorSchemeId;
  onChange: (value: AssemblyColorSchemeId) => void;
}) {
  return (
    <div
      className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      data-testid="assembly-color-scheme-picker"
    >
      {ASSEMBLY_COLOR_SCHEME_OPTIONS.map((scheme) => {
        const selected = value === scheme.value;
        return (
          <button
            key={scheme.value}
            type="button"
            data-testid={`assembly-color-scheme-${scheme.value}`}
            aria-pressed={selected}
            onClick={() => onChange(scheme.value)}
            className={`rounded-md p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
              selected
                ? 'bg-accent/10'
                : 'bg-black/[0.025] hover:bg-black/[0.06] dark:bg-white/[0.035] dark:hover:bg-white/[0.075]'
            }`}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-xs font-semibold text-fg">{scheme.label}</span>
            </div>
            <div
              data-testid={`assembly-color-scheme-swatches-${scheme.value}`}
              className="mt-2 flex h-3 overflow-hidden rounded-sm"
            >
              {scheme.colors.slice(0, 10).map((color, index) => (
                <span
                  key={`${scheme.value}-${color.hex}-${index}`}
                  aria-hidden
                  className="min-w-0 flex-1"
                  style={{ backgroundColor: color.hex }}
                />
              ))}
            </div>
          </button>
        );
      })}
    </div>
  );
}

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];
const ZOOM_FACTORS = [1, 1.25, 1.5, 1.75, 2];
function zoomPercent(factor: number): string {
  return `${Math.round(factor * 10000) / 100}%`;
}
function RecoveryStatus({
  phase,
  retry,
  name,
  details,
}: {
  phase: AppearancePhase;
  retry: () => void;
  name: string;
  details?: ReactNode;
}) {
  const message =
    phase === 'unsaved'
      ? 'Applied for this session. Could not save.'
      : phase === 'temporary'
        ? 'Applied for this session only.'
        : phase === 'apply_failed'
          ? 'Could not confirm this change.'
          : phase === 'read_failed'
            ? 'Could not load the saved preference.'
            : phase === 'saving'
              ? 'Saving…'
              : phase === 'applying'
                ? 'Applying…'
                : phase === 'loading'
                  ? 'Loading saved preference…'
                  : null;
  if (!message) return null;
  const recoverable = ['unsaved', 'apply_failed', 'read_failed'].includes(phase);
  return (
    <div
      className="mt-2 text-xs text-fg-muted"
      role={recoverable ? 'alert' : 'status'}
      data-testid={`appearance-${name}-status`}
    >
      {message}
      {details}
      {recoverable && (
        <button
          type="button"
          className="ml-2 underline"
          onClick={retry}
          aria-label={`Retry ${name}`}
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function AppearanceSection({ sectionRef }: { sectionRef?: Ref<HTMLDivElement> }) {
  const theme = useDarkMode();
  const palette = useAssemblyColorSchemeStore();
  const zoom = useDisplayZoomStore();
  const webgl = useWebGLPreferenceStore();
  useEffect(() => {
    void applyZoomLevel(true);
    void hydrateWebGLPerformancePreference(true);
    useAssemblyColorSchemeStore.getState().hydrate(true);
  }, []);
  const factors = ZOOM_FACTORS.includes(zoom.selectedFactor)
    ? ZOOM_FACTORS
    : [...ZOOM_FACTORS, zoom.selectedFactor].sort((a, b) => a - b);
  return (
    <div className="ph-no-capture rr-block" data-ph-no-capture data-analytics-block data-ph-mask>
      <SettingsSection
        id="settings-appearance"
        title={SETTINGS_SECTIONS.appearance.label}
        testId="settings-section-appearance"
        sectionRef={sectionRef}
        flushTop
      >
        <SettingsRow {...settingsRowProps('theme')}>
          <div>
            <SettingsSegmentedControl
              value={theme.themeMode}
              options={THEME_OPTIONS}
              onChange={(value) => {
                if (value === 'system' || value === 'light' || value === 'dark')
                  theme.setThemeMode(value);
              }}
              testIdPrefix="theme-toggle"
            />
            <RecoveryStatus
              phase={theme.persistence.phase}
              retry={theme.retryPersistence}
              name="theme"
            />
          </div>
        </SettingsRow>
        <SettingsRow {...settingsRowProps('fragment-colors')}>
          <div>
            <AssemblyColorSchemePicker
              value={palette.assemblyColorScheme}
              onChange={palette.setAssemblyColorScheme}
            />
            <RecoveryStatus phase={palette.phase} retry={palette.retryPersistence} name="palette" />
          </div>
        </SettingsRow>
        <SettingsRow {...settingsRowProps('display-scale')}>
          <div>
            <SettingsSelect
              value={String(zoom.selectedFactor)}
              onValueChange={(value) => {
                const factor = parseWindowZoomFactor(value);
                if (factor !== null) void setDisplayZoom(factor);
              }}
              options={factors.map((factor) => ({
                value: String(factor),
                label: zoomPercent(factor),
              }))}
              ariaLabel="Display Scale"
              testId="display-scale-select"
              disabled={!isDesktopRuntime()}
              title={isDesktopRuntime() ? undefined : 'Available in the desktop app'}
              privateContent
            />
            <RecoveryStatus
              phase={zoom.phase}
              retry={() => {
                void retryDisplayZoom();
              }}
              name="display"
              details={
                zoom.phase === 'apply_failed' ? (
                  <div data-testid="appearance-display-readback" className="mt-1">
                    <div>Requested scale: {zoomPercent(zoom.selectedFactor)}.</div>
                    <div>
                      {zoom.factor === null
                        ? 'Current scale is unconfirmed.'
                        : `Last confirmed scale: ${zoomPercent(zoom.factor)}.`}
                    </div>
                  </div>
                ) : undefined
              }
            />
          </div>
        </SettingsRow>
        <SettingsRow {...settingsRowProps('webgl-performance')}>
          <div>
            <SettingsSelect
              value={webgl.value}
              onValueChange={(value) => {
                void setWebGLPerformancePreference(value);
              }}
              options={SEQUENCE_WEBGL_PERFORMANCE_PREFERENCES.map((value) => ({
                value,
                label: value === 'auto' ? 'Auto' : value === 'quality' ? 'Quality' : 'Stability',
              }))}
              ariaLabel="WebGL Performance"
              testId="webgl-performance-preference-select"
              privateContent
            />
            <RecoveryStatus
              phase={webgl.phase}
              retry={() => {
                void retryWebGLPerformancePreference();
              }}
              name="webgl"
            />
          </div>
        </SettingsRow>
        <SettingsToggle
          {...settingsRowProps('reduced-motion')}
          disabledReason={userMessage('settings.notAvailableYet')}
          checked={false}
          onChange={() => {}}
          disabled
        />
      </SettingsSection>
    </div>
  );
}
