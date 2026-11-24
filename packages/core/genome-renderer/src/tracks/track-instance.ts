import type { Track, TrackTypeDefinition, TrackSettingsDefinition } from './types';

export function createTrackInstance(
  definition: TrackTypeDefinition,
  instance: Omit<Track, 'type' | 'visible'> & { type?: string; visible?: boolean }
): Track {
  return {
    ...instance,
    type: instance.type ?? definition.type,
    visible: instance.visible ?? definition.defaultVisible ?? true,
    sizing: instance.sizing ?? definition.defaultSizing,
    label: instance.label ?? definition.label,
    color: instance.color ?? definition.defaultColor,
  };
}

export interface SavedTrackSettings {
  version?: number;
  settings?: Readonly<Record<string, unknown>>;
}

export function migrateTrackSettings(
  definition: TrackSettingsDefinition,
  saved: SavedTrackSettings
): SavedTrackSettings {
  let version = saved.version ?? definition.version;
  let settings = saved.settings ?? {};
  while (version < definition.version) {
    const migrate = definition.migrations?.[version];
    if (!migrate) throw new Error(`Missing track settings migration from version ${version}`);
    settings = migrate(settings);
    version++;
  }
  return { version, settings };
}

export function resolveTrackSettings(
  definition: TrackSettingsDefinition,
  saved?: SavedTrackSettings
): Readonly<Record<string, unknown>> {
  const { settings } = migrateTrackSettings(definition, saved ?? {});
  const effective = { ...settings };
  for (const control of definition.controls) {
    const value = effective[control.key];
    effective[control.key] =
      typeof value === 'number' && Number.isFinite(value)
        ? Math.max(control.min, Math.min(control.max, value))
        : control.defaultValue;
  }
  return effective;
}
