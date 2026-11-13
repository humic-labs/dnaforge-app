import {
  SettingsInput,
  SettingsRow,
  SettingsSelect,
  SettingsSubsection,
  SettingsTextarea,
  SettingsToggle,
} from '../../components/SettingsSubsection';
import { settingsRowProps } from '../../components/settings-catalog';
import { parseTerminalPreferences, type TerminalPreferences } from './terminal-preferences';
import {
  TERMINAL_SETTINGS_GROUPS,
  type TerminalSettingsTargetId,
} from './terminal-settings-fields';

export function TerminalSettings({
  value,
  onChange,
}: {
  value: TerminalPreferences;
  onChange(value: TerminalPreferences): void;
}) {
  const update = (key: keyof TerminalPreferences, entry: string | number | boolean | string[]) =>
    onChange(parseTerminalPreferences({ ...value, [key]: entry }));
  return TERMINAL_SETTINGS_GROUPS.map((group) => (
    <SettingsSubsection key={group.title} title={group.title}>
      {group.fields.map((field) => {
        const target = `terminal-${field.key}` as TerminalSettingsTargetId;
        const props = settingsRowProps(target);
        if (field.kind === 'toggle')
          return (
            <SettingsToggle
              key={field.key}
              {...props}
              checked={value[field.key] === true}
              onChange={(checked) => update(field.key, checked)}
            />
          );
        return (
          <SettingsRow key={field.key} {...props} htmlFor={target}>
            {field.kind === 'select' ? (
              <SettingsSelect
                ariaLabel={field.label}
                value={String(value[field.key])}
                options={[...field.options]}
                onValueChange={(entry) => update(field.key, field.numeric ? Number(entry) : entry)}
              />
            ) : field.kind === 'lines' ? (
              <SettingsTextarea
                id={target}
                aria-label={field.label}
                rows={3}
                value={value.stickyScrollIgnoredCommands.join('\n')}
                onChange={(event) => update(field.key, event.target.value.split('\n'))}
              />
            ) : (
              <SettingsInput
                id={target}
                aria-label={field.label}
                type={field.kind === 'number' ? 'number' : 'text'}
                {...(field.kind === 'number'
                  ? { min: field.min, max: field.max, step: field.step ?? 1 }
                  : { maxLength: 256 })}
                value={String(value[field.key])}
                onChange={(event) =>
                  update(
                    field.key,
                    field.kind === 'number' ? Number(event.target.value) : event.target.value
                  )
                }
              />
            )}
          </SettingsRow>
        );
      })}
    </SettingsSubsection>
  ));
}
