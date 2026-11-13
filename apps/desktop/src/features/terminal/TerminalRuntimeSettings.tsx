import type { TerminalRuntimePolicy } from '../../shared/terminal-runtime-policy';
import {
  SettingsInput,
  SettingsRow,
  SettingsSelect,
  SettingsSubsection,
  SettingsToggle,
} from '../../components/SettingsSubsection';
import { settingsRowProps } from '../../components/settings-catalog';

export function TerminalRuntimeSettings({
  value,
  busy,
  onChange,
}: {
  value: TerminalRuntimePolicy;
  busy: boolean;
  onChange(value: TerminalRuntimePolicy): void;
}) {
  const update = <K extends keyof TerminalRuntimePolicy>(key: K, entry: TerminalRuntimePolicy[K]) =>
    onChange({ ...value, [key]: entry });
  return (
    <>
      <SettingsSubsection title="Sessions" testId="terminal-settings-sessions">
        <SettingsRow {...settingsRowProps('terminal-startup')}>
          <SettingsSelect
            ariaLabel="Terminal panel at startup"
            value={value.startupVisibility}
            disabled={busy}
            options={[
              { value: 'remember', label: 'Remember visibility' },
              { value: 'hidden', label: 'Hidden' },
              { value: 'visible', label: 'Visible' },
            ]}
            onValueChange={(entry) =>
              update(
                'startupVisibility',
                entry === 'hidden' || entry === 'visible' ? entry : 'remember'
              )
            }
          />
        </SettingsRow>
        <SettingsToggle
          {...settingsRowProps('terminal-save-sessions')}
          checked={value.persistSessions}
          disabled={busy}
          onChange={(entry) => update('persistSessions', entry)}
        />
        <SettingsToggle
          {...settingsRowProps('terminal-revive-sessions')}
          checked={value.reviveSessions}
          disabled={busy}
          onChange={(entry) => update('reviveSessions', entry)}
        />
        <SettingsRow {...settingsRowProps('terminal-history')} htmlFor="terminal-history-limit">
          <SettingsInput
            id="terminal-history-limit"
            aria-label="Recent history entries per shell"
            type="number"
            min={0}
            max={1000}
            disabled={busy}
            value={value.historyLimit}
            onChange={(event) =>
              update(
                'historyLimit',
                Math.max(0, Math.min(1000, Math.round(Number(event.target.value) || 0)))
              )
            }
          />
        </SettingsRow>
        <SettingsToggle
          {...settingsRowProps('terminal-close-confirmation')}
          checked={value.confirmBusyClose}
          disabled={busy}
          onChange={(entry) => update('confirmBusyClose', entry)}
        />
        <SettingsToggle
          {...settingsRowProps('terminal-exit-notice')}
          checked={value.notifyNonzeroExit}
          disabled={busy}
          onChange={(entry) => update('notifyNonzeroExit', entry)}
        />
      </SettingsSubsection>
      <SettingsSubsection title="Shell input">
        <SettingsToggle
          {...settingsRowProps('terminal-environment')}
          checked={value.inheritEnvironment}
          disabled={busy}
          onChange={(entry) => update('inheritEnvironment', entry)}
        />
        <SettingsRow {...settingsRowProps('terminal-locale')}>
          <SettingsSelect
            ariaLabel="Locale for new shells"
            value={value.locale}
            disabled={busy}
            options={[
              { value: 'inherit', label: 'Inherit locale' },
              { value: 'utf8', label: 'Use UTF-8' },
            ]}
            onValueChange={(entry) => update('locale', entry === 'utf8' ? 'utf8' : 'inherit')}
          />
        </SettingsRow>
        <SettingsRow {...settingsRowProps('terminal-unicode')}>
          <SettingsSelect
            ariaLabel="Unicode widths"
            value={value.unicodeVersion}
            disabled={busy}
            options={[
              { value: '11', label: 'Unicode 11' },
              { value: '6', label: 'Unicode 6' },
            ]}
            onValueChange={(entry) => update('unicodeVersion', entry === '6' ? '6' : '11')}
          />
        </SettingsRow>
        <SettingsRow {...settingsRowProps('terminal-tabs')} htmlFor="terminal-tab-spacing">
          <SettingsInput
            id="terminal-tab-spacing"
            aria-label="Tab spacing"
            type="number"
            min={1}
            max={32}
            disabled={busy}
            value={value.tabStopWidth}
            onChange={(event) =>
              update(
                'tabStopWidth',
                Math.max(1, Math.min(32, Math.round(Number(event.target.value) || 1)))
              )
            }
          />
        </SettingsRow>
      </SettingsSubsection>
    </>
  );
}
