import {
  SettingsButton,
  SettingsInput,
  SettingsRow,
  SettingsSelect,
  SettingsTextarea,
  SettingsToggle,
} from '../../components/SettingsSubsection';
import type { TerminalPort } from '../../shared/terminal-port';
import { useEffect, useState } from 'react';
import type { TerminalProfile, TerminalProfilesConfiguration } from '../../shared/terminal-ipc';

export function TerminalProfileSettings({
  port,
  onSaved,
  onClose,
  onError,
}: {
  port: TerminalPort;
  onSaved(profiles: TerminalProfile[], defaultId?: string): void;
  onClose(): void;
  onError(message: string): void;
}) {
  const [configuration, setConfiguration] = useState<TerminalProfilesConfiguration>({
    profiles: [],
  });
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [args, setArgs] = useState('-il');
  const [environment, setEnvironment] = useState('');
  const [makeDefault, setMakeDefault] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void port
      .profileConfiguration()
      .then(setConfiguration)
      .catch((error: unknown) => onError(String(error)));
  }, [port, onError]);
  const choose = (id: string) => {
    setSelected(id);
    const profile = configuration.profiles.find((candidate) => candidate.id === id);
    setName(profile?.name ?? '');
    setPath(profile?.path ?? '');
    setArgs(profile?.args.join('\n') ?? '-il');
    setEnvironment(
      Object.entries(profile?.env ?? {})
        .map(([key, value]) => (value === null ? `!${key}` : `${key}=${value}`))
        .join('\n')
    );
    setMakeDefault(!id || id === configuration.defaultProfileId);
  };
  const save = async (remove = false) => {
    setSaving(true);
    try {
      const id = selected || `custom-${crypto.randomUUID()}`;
      const env: Record<string, string | null> = {};
      for (const line of environment.split(/\r?\n/).filter(Boolean)) {
        const split = line.indexOf('=');
        if (line.startsWith('!')) env[line.slice(1)] = null;
        else if (split > 0) env[line.slice(0, split)] = line.slice(split + 1);
        else throw new Error('Enter environment values as NAME=value, or !NAME to unset a value.');
      }
      const remaining = configuration.profiles.filter((profile) => profile.id !== id);
      const profile: TerminalProfile = {
        id,
        name,
        path,
        args: args.split(/\r?\n/).filter(Boolean),
        env,
      };
      const defaultProfileId =
        remove && configuration.defaultProfileId === id
          ? undefined
          : !remove && makeDefault
            ? id
            : configuration.defaultProfileId;
      const updated: TerminalProfilesConfiguration = {
        profiles: remove ? remaining : [...remaining, profile],
        ...(defaultProfileId ? { defaultProfileId } : {}),
      };
      await port.configureProfiles(updated);
      onSaved(await port.profiles(), defaultProfileId);
      onClose();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      aria-label="Terminal profiles"
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <SettingsRow label="Profile">
        <SettingsSelect
          ariaLabel="Edit terminal profile"
          value={selected}
          options={[
            { value: '', label: 'New profile' },
            ...configuration.profiles.map((profile) => ({
              value: profile.id,
              label: profile.name,
            })),
          ]}
          onValueChange={choose}
          disabled={saving}
        />
      </SettingsRow>
      <SettingsRow label="Name" htmlFor="terminal-profile-name">
        <SettingsInput
          id="terminal-profile-name"
          aria-label="Shell profile name"
          value={name}
          required
          maxLength={128}
          disabled={saving}
          onChange={(event) => setName(event.target.value)}
        />
      </SettingsRow>
      <SettingsRow label="Shell path" htmlFor="terminal-profile-path">
        <SettingsInput
          id="terminal-profile-path"
          aria-label="Shell executable path"
          value={path}
          required
          placeholder="/bin/bash"
          disabled={saving}
          onChange={(event) => setPath(event.target.value)}
        />
      </SettingsRow>
      <SettingsRow
        label="Arguments"
        description="Enter one argument per line."
        htmlFor="terminal-profile-args"
      >
        <SettingsTextarea
          id="terminal-profile-args"
          aria-label="Shell arguments"
          rows={2}
          value={args}
          disabled={saving}
          onChange={(event) => setArgs(event.target.value)}
        />
      </SettingsRow>
      <SettingsRow
        label="Environment"
        description="Enter NAME=value to set a variable, or !NAME to remove one. Use one line per variable."
        htmlFor="terminal-profile-environment"
      >
        <SettingsTextarea
          id="terminal-profile-environment"
          aria-label="Shell environment"
          rows={3}
          value={environment}
          disabled={saving}
          onChange={(event) => setEnvironment(event.target.value)}
        />
      </SettingsRow>
      <SettingsToggle
        label="Use as default shell"
        checked={makeDefault}
        disabled={saving}
        onChange={setMakeDefault}
      />
      <div className="flex flex-wrap gap-3 pt-2">
        <SettingsButton type="submit" variant="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </SettingsButton>
        {selected && (
          <SettingsButton variant="danger" disabled={saving} onClick={() => void save(true)}>
            Remove profile
          </SettingsButton>
        )}
        <SettingsButton disabled={saving} onClick={onClose}>
          Cancel
        </SettingsButton>
      </div>
    </form>
  );
}
