import { describe, expect, it } from 'vitest';

import {
  defaultNodeAppDataRoot,
  resolveReferenceAssetCacheRoot,
  resolveReferenceAssetPublicationRoot,
  resolveReferenceAssetRootLayout,
} from './reference-asset-cache-root';

describe('reference asset cache root', () => {
  const appDataRoot = '/Users/test/Library/Application Support';

  it('shares immutable payload bytes while isolating a development profile pointer', () => {
    expect(
      resolveReferenceAssetRootLayout({
        appDataRoot,
        userDataRoot: `${appDataRoot}/DNAForge-dev-1463`,
        env: {},
      })
    ).toEqual({
      cacheRoot: `${appDataRoot}/DNAForge/reference-assets`,
      publicationRoot: `${appDataRoot}/DNAForge-dev-1463/reference-asset-publications`,
      fallbackPublicationRoot: `${appDataRoot}/DNAForge/reference-assets`,
    });
  });

  it('preserves the installed app payload and pointer location', () => {
    const input = {
      appDataRoot,
      userDataRoot: `${appDataRoot}/DNAForge`,
      env: {},
    };
    expect(resolveReferenceAssetCacheRoot(input)).toBe(`${appDataRoot}/DNAForge/reference-assets`);
    expect(resolveReferenceAssetPublicationRoot(input)).toBe(
      `${appDataRoot}/DNAForge/reference-assets`
    );
    expect(resolveReferenceAssetRootLayout(input).fallbackPublicationRoot).toBeNull();
  });

  it('treats an explicit absolute override as one isolated payload and pointer boundary', () => {
    expect(
      resolveReferenceAssetRootLayout({
        appDataRoot: '/ignored',
        userDataRoot: '/also-ignored',
        env: { DNAFORGE_REFERENCE_ASSET_ROOT: '/Volumes/reference-cache' },
      })
    ).toEqual({
      cacheRoot: '/Volumes/reference-cache',
      publicationRoot: '/Volumes/reference-cache',
      fallbackPublicationRoot: null,
    });
  });

  it('can read an explicit immutable cache while keeping mutable pointers profile-owned', () => {
    expect(
      resolveReferenceAssetRootLayout({
        appDataRoot: '/ignored',
        userDataRoot: '/tmp/electron-profile',
        env: { DNAFORGE_REFERENCE_ASSET_CACHE_ROOT: '/Volumes/reference-cache' },
      })
    ).toEqual({
      cacheRoot: '/Volumes/reference-cache',
      publicationRoot: '/tmp/electron-profile/reference-asset-publications',
      fallbackPublicationRoot: '/Volumes/reference-cache',
    });
  });

  it('rejects a relative override', () => {
    expect(() =>
      resolveReferenceAssetCacheRoot({
        appDataRoot: '/app-data',
        env: { DNAFORGE_REFERENCE_ASSET_ROOT: '../reference-cache' },
      })
    ).toThrow('DNAFORGE_REFERENCE_ASSET_ROOT must be an absolute path');
    expect(() =>
      resolveReferenceAssetCacheRoot({
        appDataRoot: '/app-data',
        env: { DNAFORGE_REFERENCE_ASSET_CACHE_ROOT: '../reference-cache' },
      })
    ).toThrow('DNAFORGE_REFERENCE_ASSET_CACHE_ROOT must be an absolute path');
  });

  it('matches Electron appData conventions in the standalone CLI', () => {
    expect(defaultNodeAppDataRoot('darwin', {}, '/Users/test')).toBe(
      '/Users/test/Library/Application Support'
    );
    expect(defaultNodeAppDataRoot('linux', {}, '/home/test')).toBe('/home/test/.config');
    expect(defaultNodeAppDataRoot('linux', { XDG_CONFIG_HOME: '/config' }, '/home/test')).toBe(
      '/config'
    );
    expect(
      defaultNodeAppDataRoot(
        'win32',
        { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
        'C:\\Users\\test'
      )
    ).toBe('C:\\Users\\test\\AppData\\Roaming');
  });
});
