import { toUserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useState } from 'react';
import {
  SettingsNotice,
  SettingsSection,
  SettingsSubsection,
} from '../../components/SettingsSubsection';
import { settingsSubsectionProps } from '../../components/settings-catalog';
import { platform } from '../../platform';
import type { TerminalRuntimePolicy } from '../../shared/terminal-runtime-policy';
import { TerminalSettings } from './TerminalSettings';
import { TerminalRuntimeSettings } from './TerminalRuntimeSettings';
import { TerminalProfileSettings } from './TerminalProfileSettings';
import {
  announceTerminalProfilesChanged,
  saveTerminalPreferences,
  useTerminalPreferences,
} from './terminal-settings-store';

export function TerminalSettingsSection() {
  const [port] = useState(() => platform().terminal);
  const appearance = useTerminalPreferences();
  const [policy, setPolicy] = useState<TerminalRuntimePolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [profileVersion, setProfileVersion] = useState(0);
  const report = useCallback(
    (message: string) => setError(toUserMessage(message, 'operation.failed')),
    []
  );
  useEffect(() => {
    let cancelled = false;
    void port
      ?.runtimePolicy()
      .then((value) => {
        if (!cancelled) setPolicy(value);
      })
      .catch((error) => {
        if (!cancelled) setError(toUserMessage(error, 'operation.failed'));
      });
    return () => {
      cancelled = true;
    };
  }, [port]);
  return (
    <SettingsSection title="Terminal" testId="settings-section-terminal" flushTop>
      {error && (
        <SettingsNotice tone="error">{toUserMessage(error, 'operation.failed')}</SettingsNotice>
      )}
      <TerminalSettings
        value={appearance}
        onChange={(value) => {
          try {
            saveTerminalPreferences(value);
            setError('');
          } catch (error) {
            setError(toUserMessage(error, 'operation.failed'));
          }
        }}
      />
      {port && policy && (
        <TerminalRuntimeSettings
          value={policy}
          busy={busy}
          onChange={(value) => {
            setBusy(true);
            setError('');
            void port
              .configureRuntimePolicy(value)
              .then(setPolicy)
              .catch((error) => setError(toUserMessage(error, 'operation.failed')))
              .finally(() => setBusy(false));
          }}
        />
      )}
      {port && (
        <SettingsSubsection
          {...settingsSubsectionProps('terminal-profiles')}
          testId="terminal-settings-profiles"
        >
          <TerminalProfileSettings
            key={profileVersion}
            port={port}
            onError={report}
            onSaved={() => {
              announceTerminalProfilesChanged();
              setError('');
            }}
            onClose={() => setProfileVersion((value) => value + 1)}
          />
        </SettingsSubsection>
      )}
    </SettingsSection>
  );
}
