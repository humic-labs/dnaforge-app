import { isAbsolute } from 'node:path';
import type { TerminalProfile, TerminalProfilesConfiguration } from '../../shared/terminal-ipc';

export function validateTerminalProfileConfiguration(
  value: unknown
): TerminalProfilesConfiguration {
  if (
    !value ||
    typeof value !== 'object' ||
    !('profiles' in value) ||
    !Array.isArray(value.profiles) ||
    value.profiles.length > 32
  )
    throw new Error('Invalid terminal profiles.');
  const ids = new Set<string>();
  const profiles: TerminalProfile[] = value.profiles.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid terminal profile.');
    const profile = entry as Partial<TerminalProfile>;
    if (
      typeof profile.id !== 'string' ||
      !profile.id ||
      profile.id.length > 128 ||
      ids.has(profile.id)
    ) {
      throw new Error('Invalid or duplicate terminal profile identity.');
    }
    ids.add(profile.id);
    if (
      typeof profile.name !== 'string' ||
      !profile.name.trim() ||
      profile.name.length > 128 ||
      /\p{Cc}/u.test(profile.name)
    ) {
      throw new Error('Invalid terminal profile name.');
    }
    if (
      typeof profile.path !== 'string' ||
      !isAbsolute(profile.path) ||
      profile.path.includes('\0')
    ) {
      throw new Error('Terminal profile executable must be an absolute path.');
    }
    if (
      !Array.isArray(profile.args) ||
      profile.args.length > 64 ||
      profile.args.some(
        (argument) =>
          typeof argument !== 'string' || argument.length > 8192 || argument.includes('\0')
      )
    ) {
      throw new Error('Invalid terminal profile arguments.');
    }
    let env: Record<string, string | null> | undefined;
    if (profile.env !== undefined) {
      if (!profile.env || typeof profile.env !== 'object' || Array.isArray(profile.env))
        throw new Error('Invalid terminal profile environment.');
      const entries = Object.entries(profile.env);
      if (
        entries.length > 128 ||
        entries.some(
          ([key, item]) =>
            !key ||
            key.length > 256 ||
            /[=\p{Cc}]/u.test(key) ||
            (item !== null &&
              (typeof item !== 'string' || item.length > 65_536 || item.includes('\0')))
        )
      ) {
        throw new Error('Invalid terminal profile environment.');
      }
      env = Object.fromEntries(entries);
    }
    return {
      id: profile.id,
      name: profile.name.trim(),
      path: profile.path,
      args: [...profile.args],
      ...(env ? { env } : {}),
    };
  });
  const defaultProfileId = 'defaultProfileId' in value ? value.defaultProfileId : undefined;
  if (
    defaultProfileId !== undefined &&
    (typeof defaultProfileId !== 'string' || !defaultProfileId)
  ) {
    throw new Error('Invalid default terminal profile.');
  }
  return { profiles, ...(typeof defaultProfileId === 'string' ? { defaultProfileId } : {}) };
}
