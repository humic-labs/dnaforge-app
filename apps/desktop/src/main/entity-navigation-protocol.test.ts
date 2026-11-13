import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEntityNavigationProtocol } from './entity-navigation-protocol';

describe('native development entity protocol ownership', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'fixture-native-protocol-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function fixture(accepted = true) {
    const entry = join(directory, 'out/main/index.js');
    const executable = join(
      directory,
      '.cache/dnaforge-dev-runtime/version/Electron.app/Contents/MacOS/Electron'
    );
    const configPath = join(directory, '.cache/dnaforge-dev-runtime/runtime.json');
    for (const file of [entry, executable]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '');
    }
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        appDirectory: directory,
        entry,
        electronBinary: executable,
        scheme: 'dnaforge-dev-1827',
        environment: {},
      })
    );
    const app = {
      isPackaged: false,
      getAppPath: vi.fn(() => directory),
      getPath: vi.fn(() => join(directory, 'private-profile')),
      setAsDefaultProtocolClient: vi.fn(() => accepted),
    };
    const protocol = createEntityNavigationProtocol({
      app,
      env: {
        DNAFORGE_DEV_RUNTIME_CONFIG: configPath,
        DNAFORGE_DEV_ENTITY_SCHEME: 'dnaforge-dev-1827',
      },
      argv: [executable, directory],
      executable,
      testRuntime: false,
      defaultScheme: () => 'dnaforge-dev',
    });
    return { app, protocol, configPath, executable, entry };
  }

  it('publishes only its registered runtime and remembers the real profile for cold opens', () => {
    const { app, protocol, configPath, executable } = fixture();
    protocol.prepare();
    expect(protocol.getScheme()).toBe('dnaforge-dev-1827');
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('dnaforge-dev-1827', executable, [
      directory,
    ]);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).userDataDir).toBe(
      join(directory, 'private-profile')
    );
    expect(protocol.acceptsUrl('dnaforge-dev-1827://entity/open?entityId=one')).toBe(true);
    expect(protocol.acceptsUrl('dnaforge-dev-1828://entity/open?entityId=one')).toBe(false);
  });

  it('returns an explicit failure when macOS refuses registration', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { protocol } = fixture(false);
    protocol.prepare();
    expect(() => protocol.getScheme()).toThrow('operating system refused');
  });

  it('refuses a runtime that loaded the build directory instead of the owning application', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { app, protocol } = fixture();
    app.getAppPath.mockReturnValue(join(directory, 'out/main'));
    protocol.prepare();
    expect(() => protocol.getScheme()).toThrow('does not belong');
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it('preserves packaged and explicitly isolated test channels without changing OS defaults', () => {
    const { app } = fixture();
    const protocol = createEntityNavigationProtocol({
      app: { ...app, isPackaged: true },
      env: {},
      argv: [],
      executable: '/installed/DNAForge',
      testRuntime: false,
      defaultScheme: () => 'dnaforge-beta',
    });
    protocol.prepare();
    expect(protocol.getScheme()).toBe('dnaforge-beta');
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });
});
