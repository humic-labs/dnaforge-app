import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureDevelopmentCredentialIdentity,
  DevelopmentCredentialIdentityError,
} from './development-credential-identity';

const metadata = vi.hoisted(() => ({ plists: new Map<string, string>(), commands: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => {
    metadata.commands(...args);
    const [command, argv] = args as [string, string[]];
    if (
      command !== '/usr/bin/plutil' ||
      argv.slice(0, 5).join(' ') !== '-extract CFBundleIdentifier raw -o -'
    )
      throw new Error('Unexpected metadata command');
    const value = metadata.plists.get(argv[5]);
    if (!value) throw new Error('Missing plist metadata fixture');
    return value + '\n';
  },
}));

const { developmentApplicationIdentity } = createRequire(import.meta.url)(
  '../../scripts/dev-app-runtime.cjs'
);
const directories: string[] = [];

function fixture(fingerprint = 'a'.repeat(24)) {
  const appDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-credential-identity-')));
  directories.push(appDirectory);
  const cacheRoot = join(appDirectory, '.cache/dnaforge-dev-runtime');
  const versionDirectory = join(cacheRoot, fingerprint);
  const bundle = join(versionDirectory, 'Electron.app');
  const execPath = join(bundle, 'Contents/MacOS/Electron');
  const entryPath = join(appDirectory, 'out/main/index.js');
  const plist = join(bundle, 'Contents/Info.plist');
  const identity = developmentApplicationIdentity(appDirectory, '63202');
  const bundleId = `${identity.bundleId}.${fingerprint}`;
  const configPath = join(cacheRoot, 'runtime.json');
  const readyPath = join(versionDirectory, 'ready.json');
  const configuration = {
    schemaVersion: 1,
    appDirectory,
    entry: entryPath,
    electronBinary: execPath,
    scheme: identity.scheme,
    environment: {},
  };
  const ready = { ...identity, bundleId, fingerprint };
  for (const file of [execPath, entryPath]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'owned fixture');
  }
  writeFileSync(
    plist,
    `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`
  );
  metadata.plists.set(plist, bundleId);
  const writeMetadata = () => {
    writeFileSync(configPath, JSON.stringify(configuration));
    writeFileSync(readyPath, JSON.stringify(ready));
  };
  writeMetadata();
  let name = 'DNAForge';
  const events: unknown[][] = [];
  const pinned = new Map<string, string>();
  const app = {
    isPackaged: false,
    isReady: () => false,
    getAppPath: () => appDirectory,
    getPath: (key: 'userData' | 'sessionData') => pinned.get(key) ?? join(appDirectory, name, key),
    setPath: (key: 'userData' | 'sessionData', value: string) => {
      events.push(['path', key, value]);
      pinned.set(key, value);
    },
    setName: (value: string) => {
      events.push(['name', value]);
      name = value;
    },
  };
  const input = {
    app,
    entryPath,
    execPath,
    platform: 'darwin' as const,
    env: { DNAFORGE_DEV_RUNTIME_CONFIG: configPath },
  };
  return {
    appDirectory,
    configPath,
    readyPath,
    plist,
    configuration,
    ready,
    writeMetadata,
    app,
    input,
    events,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  metadata.plists.clear();
  metadata.commands.mockClear();
});

describe('development credential identity', () => {
  it('restores the prepared identity after interaction suppression and before Electron initialization', () => {
    const source = readFileSync(new URL('./bootstrap.ts', import.meta.url), 'utf8');
    const guard = source.indexOf('disableKeychainInteraction({');
    const identity = source.indexOf('configureDevelopmentCredentialIdentity({');
    const initialize = source.indexOf('configureElectronBeforeReady();');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(identity).toBeGreaterThan(guard);
    expect(identity).toBeLessThan(initialize);
  });

  it('uses the complete prepared bundle identity and preserves selected profile paths and bytes', () => {
    const f = fixture();
    const userData = f.app.getPath('userData');
    const sessionData = f.app.getPath('sessionData');
    const sessionsFile = join(userData, 'auth/sessions.json');
    const ciphertext =
      '{"schemaVersion":1,"activeAccountId":"old","sessions":{"old":"opaque-ciphertext"}}';
    mkdirSync(dirname(sessionsFile), { recursive: true });
    writeFileSync(sessionsFile, ciphertext);
    const name = configureDevelopmentCredentialIdentity(f.input);
    expect(name).toBe(`DNAForge Dev ${f.ready.bundleId.slice('com.dnaforge.development.'.length)}`);
    expect(name).not.toBe('DNAForge');
    expect(f.app.getPath('userData')).toBe(userData);
    expect(f.app.getPath('sessionData')).toBe(sessionData);
    expect(f.events).toEqual([
      ['path', 'userData', userData],
      ['path', 'sessionData', sessionData],
      ['name', name],
    ]);
    expect(readFileSync(sessionsFile, 'utf8')).toBe(ciphertext);
    expect(metadata.commands).toHaveBeenCalledOnce();
    expect(metadata.commands.mock.calls[0][1]).toEqual([
      '-extract',
      'CFBundleIdentifier',
      'raw',
      '-o',
      '-',
      f.plist,
    ]);
  });

  it('separates worktrees and wrapper fingerprints that reuse the same port', () => {
    const a = fixture();
    const b = fixture('b'.repeat(24));
    expect(a.configuration.scheme).toBe(b.configuration.scheme);
    expect(configureDevelopmentCredentialIdentity(a.input)).not.toBe(
      configureDevelopmentCredentialIdentity(b.input)
    );
  });

  it.each(['packaged', 'other-platform', 'no-config'] as const)(
    'leaves %s launches untouched',
    (kind) => {
      const f = fixture();
      const input = {
        ...f.input,
        platform: kind === 'other-platform' ? ('linux' as const) : ('darwin' as const),
        env: kind === 'no-config' ? {} : f.input.env,
      };
      f.app.isPackaged = kind === 'packaged';
      expect(configureDevelopmentCredentialIdentity(input)).toBeNull();
      expect(f.events).toEqual([]);
      expect(metadata.commands).not.toHaveBeenCalled();
    }
  );

  it.each([
    'schema',
    'app-directory',
    'entry',
    'executable',
    'ready-fingerprint',
    'ready-bundle',
    'plist-bundle',
    'config-path',
  ] as const)('refuses mismatched %s before changing identity or profile paths', (kind) => {
    const f = fixture();
    if (kind === 'schema') f.configuration.schemaVersion = 2;
    if (kind === 'app-directory') f.configuration.appDirectory = dirname(f.appDirectory);
    if (kind === 'entry') f.input.entryPath = f.input.execPath;
    if (kind === 'executable') f.configuration.electronBinary = f.input.entryPath;
    if (kind === 'ready-fingerprint') f.ready.fingerprint = 'b'.repeat(24);
    if (kind === 'ready-bundle') f.ready.bundleId = 'com.dnaforge.development.other';
    if (kind === 'plist-bundle') metadata.plists.set(f.plist, 'com.dnaforge.production');
    if (kind === 'config-path') f.input.env.DNAFORGE_DEV_RUNTIME_CONFIG = f.readyPath;
    f.writeMetadata();
    expect(() => configureDevelopmentCredentialIdentity(f.input)).toThrow(
      DevelopmentCredentialIdentityError
    );
    expect(f.events).toEqual([]);
  });

  it('refuses late initialization instead of claiming an already captured namespace changed', () => {
    const f = fixture();
    f.app.isReady = () => true;
    expect(() => configureDevelopmentCredentialIdentity(f.input)).toThrow(
      DevelopmentCredentialIdentityError
    );
    expect(f.events).toEqual([]);
    expect(metadata.commands).not.toHaveBeenCalled();
  });
});
