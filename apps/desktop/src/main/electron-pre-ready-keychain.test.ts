import { beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  packaged: false,
  switches: new Map<string, string>(),
  plaintext: vi.fn(),
}));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return native.packaged;
    },
    commandLine: {
      appendSwitch: (name: string, value = '') => native.switches.set(name, value),
      removeSwitch: (name: string) => native.switches.delete(name),
    },
  },
  protocol: {},
  safeStorage: { setUsePlainTextEncryption: native.plaintext },
}));
vi.mock('./ipc/assembly-annotation-scene-scheme', () => ({
  registerAssemblyAnnotationSceneScheme: vi.fn(),
}));
vi.mock('./native-crash-reporter-start', () => ({ startNativeCrashReporter: vi.fn() }));
vi.mock('./sentry', () => ({ initSentryMain: vi.fn() }));
vi.mock('./thread-scheduling.cjs', () => ({ preferCurrentThread: vi.fn() }));

import { configureElectronBeforeReady } from './electron-pre-ready';

beforeEach(() => {
  native.packaged = false;
  native.switches.clear();
  native.switches.set('password-store', 'basic');
  native.plaintext.mockClear();
});
function configure(environment: Record<string, string> = {}, platform = 'linux', packaged = false) {
  native.packaged = packaged;
  vi.stubGlobal('process', {
    ...process,
    platform,
    env: { NODE_ENV: 'test', WAYPOINT_TEST: '1', ...environment },
    argv: ['electron', 'app'],
  });
  try {
    configureElectronBeforeReady();
  } finally {
    vi.unstubAllGlobals();
  }
}
const privateSession = {
  DNAFORGE_E2E_SYSTEM_KEYCHAIN: '1',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/owned/session-bus',
  GNOME_KEYRING_CONTROL: '/owned/keyring-control',
};

it('uses the real keyring through application startup without enabling plaintext', () => {
  configure(privateSession);
  expect(native.switches.get('password-store')).toBe('gnome-libsecret');
  expect(native.plaintext).not.toHaveBeenCalled();
});
it.each(['DBUS_SESSION_BUS_ADDRESS', 'GNOME_KEYRING_CONTROL'])(
  'refuses an incomplete private-keyring launch without %s',
  (missing) => {
    const environment: Record<string, string> = { ...privateSession };
    delete environment[missing];
    expect(() => configure(environment)).toThrow('private Secret Service');
    expect(native.plaintext).not.toHaveBeenCalled();
  }
);
it('preserves ordinary Linux source-test authentication setup', () => {
  configure();
  expect(native.switches.get('password-store')).toBe('basic');
  expect(native.plaintext).toHaveBeenCalledExactlyOnceWith(true);
});
it.each(['darwin', 'win32'])('does not select a Linux keyring on %s', (platform) => {
  configure(privateSession, platform);
  expect(native.plaintext).not.toHaveBeenCalled();
  expect(native.switches.get('password-store')).toBe('basic');
});
it('does not change packaged startup', () => {
  configure(privateSession, 'linux', true);
  expect(native.plaintext).not.toHaveBeenCalled();
  expect(native.switches.get('password-store')).toBe('basic');
});
it('does not turn a non-test launch into a keyring proof', () => {
  configure({ ...privateSession, WAYPOINT_TEST: '0' });
  expect(native.plaintext).not.toHaveBeenCalled();
  expect(native.switches.get('password-store')).toBe('basic');
});
it.each(['linux', 'win32'])('forces SwiftShader for ordinary %s launches', (platform) => {
  configure({}, platform);
  expect(native.switches.has('ignore-gpu-blocklist')).toBe(true);
  expect(native.switches.has('enable-webgl')).toBe(true);
  expect(native.switches.has('enable-unsafe-swiftshader')).toBe(true);
  expect(native.switches.get('use-angle')).toBe('swiftshader-webgl');
  expect(native.switches.get('use-gl')).toBe('angle');
});
it.each([false, true])('keeps the native macOS backend when packaged is %s', (packaged) => {
  configure({}, 'darwin', packaged);
  expect(native.switches.has('ignore-gpu-blocklist')).toBe(true);
  expect(native.switches.has('enable-webgl')).toBe(true);
  expect(native.switches.has('enable-unsafe-swiftshader')).toBe(true);
  expect(native.switches.has('use-angle')).toBe(false);
  expect(native.switches.has('use-gl')).toBe(false);
});
it.each(['linux', 'darwin', 'win32'])('forces SwiftShader for the e2e switch on %s', (platform) => {
  configure({ WAYPOINT_E2E_FORCE_SWIFTSHADER: '1' }, platform);
  expect(native.switches.get('use-angle')).toBe('swiftshader-webgl');
  expect(native.switches.get('use-gl')).toBe('angle');
  expect(native.switches.has('ignore-gpu-blocklist')).toBe(true);
  expect(native.switches.has('enable-webgl')).toBe(true);
  expect(native.switches.has('enable-unsafe-swiftshader')).toBe(true);
});
