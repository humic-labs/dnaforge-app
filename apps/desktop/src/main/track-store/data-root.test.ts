import { describe, expect, it } from 'vitest';

import { resolveDnaforgeDataRoot } from './data-root';

describe('DNAForge data root', () => {
  it('uses the machine-local half of the Windows profile, never the roaming half', () => {
    expect(
      resolveDnaforgeDataRoot({
        platform: 'win32',
        env: {
          LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
          APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
        },
        home: 'C:\\Users\\alice',
      })
    ).toBe('C:\\Users\\alice\\AppData\\Local\\DNAForge');
  });

  it('falls back to AppData\\Local under the home directory when LOCALAPPDATA is unset', () => {
    expect(resolveDnaforgeDataRoot({ platform: 'win32', env: {}, home: 'C:\\Users\\alice' })).toBe(
      'C:\\Users\\alice\\AppData\\Local\\DNAForge'
    );
  });

  it('uses Application Support on macOS', () => {
    expect(resolveDnaforgeDataRoot({ platform: 'darwin', env: {}, home: '/Users/alice' })).toBe(
      '/Users/alice/Library/Application Support/DNAForge'
    );
  });

  it('uses XDG_DATA_HOME on Linux, not the configuration directory', () => {
    expect(
      resolveDnaforgeDataRoot({
        platform: 'linux',
        env: { XDG_DATA_HOME: '/data/alice', XDG_CONFIG_HOME: '/home/alice/.config' },
        home: '/home/alice',
      })
    ).toBe('/data/alice/DNAForge');
    expect(resolveDnaforgeDataRoot({ platform: 'linux', env: {}, home: '/home/alice' })).toBe(
      '/home/alice/.local/share/DNAForge'
    );
  });

  it('ignores a relative XDG_DATA_HOME, as the XDG specification requires', () => {
    expect(
      resolveDnaforgeDataRoot({
        platform: 'linux',
        env: { XDG_DATA_HOME: 'data' },
        home: '/home/alice',
      })
    ).toBe('/home/alice/.local/share/DNAForge');
  });

  it('honours an absolute override on every platform and refuses a relative one', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(
        resolveDnaforgeDataRoot({
          platform,
          env: { DNAFORGE_DATA_ROOT: '/srv/dnaforge/' },
          home: '/ignored',
        })
      ).toBe('/srv/dnaforge');
    }
    expect(
      resolveDnaforgeDataRoot({
        platform: 'win32',
        env: { DNAFORGE_DATA_ROOT: 'D:\\dnaforge\\' },
        home: 'C:\\ignored',
      })
    ).toBe('D:\\dnaforge');
    for (const platform of ['win32', 'linux'] as const) {
      expect(() =>
        resolveDnaforgeDataRoot({ platform, env: { DNAFORGE_DATA_ROOT: 'dnaforge' }, home: '/h' })
      ).toThrow('DNAFORGE_DATA_ROOT must be an absolute path.');
    }
  });
});
