// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeGoogleSheetsController } from './native';
const native = vi.hoisted(() => ({
  directory: '',
  isPackaged: false,
  config: new Map<string, string>(),
  secureStorage: vi.fn(() => {
    throw new Error('Locked keychain');
  }),
  open: vi.fn(async (_url: string) => {}),
}));
vi.mock('electron', () => ({
  app: {
    getAppPath: () => native.directory,
    getPath: () => native.directory,
    get isPackaged() {
      return native.isPackaged;
    },
  },
  shell: { openExternal: native.open },
  safeStorage: {
    isEncryptionAvailable: native.secureStorage,
    getSelectedStorageBackend: native.secureStorage,
    encryptString: native.secureStorage,
    decryptString: native.secureStorage,
  },
}));
vi.mock('../config', () => ({ loadConfig: () => Object.fromEntries(native.config) }));
vi.mock('@sentry/electron/main', () => ({ captureMessage: vi.fn() }));
beforeEach(async () => {
  native.directory = await mkdtemp(join(tmpdir(), 'fixture-native-google-'));
  native.isPackaged = false;
  native.config.clear();
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(native.directory, { recursive: true, force: true });
});
describe('native Google Sheets configuration and idle authority', () => {
  it.each([undefined, 'malformed-client'])(
    'keeps the app and read-only status usable when a dedicated client is unavailable: %s',
    async (client) => {
      if (client) native.config.set('DNAFORGE_GOOGLE_SHEETS_DESKTOP_CLIENT_ID', client);
      const controller = createNativeGoogleSheetsController();
      try {
        expect((await controller.status()).configured).toBe(false);
        await expect(controller.start(1)).rejects.toMatchObject({ reason: 'unavailable' });
        expect(native.secureStorage).not.toHaveBeenCalled();
        expect(native.open).not.toHaveBeenCalled();
      } finally {
        await controller.dispose();
      }
    }
  );
  it('does not touch a locked keychain or browser merely to inspect a configured connection', async () => {
    native.config.set(
      'DNAFORGE_GOOGLE_SHEETS_DESKTOP_CLIENT_ID',
      'synthetic.apps.googleusercontent.com'
    );
    const controller = createNativeGoogleSheetsController();
    try {
      expect((await controller.status()).configured).toBe(true);
      expect(native.secureStorage).not.toHaveBeenCalled();
      expect(native.open).not.toHaveBeenCalled();
    } finally {
      await controller.dispose();
    }
  });
});

describe('native Google browser destination', () => {
  it('opens only the constructed Google consent URL and cancels without making an authenticated provider request', async () => {
    native.config.set(
      'DNAFORGE_GOOGLE_SHEETS_DESKTOP_CLIENT_ID',
      'synthetic.apps.googleusercontent.com'
    );
    native.open.mockResolvedValue(undefined);
    const controller = createNativeGoogleSheetsController();
    try {
      const id = await controller.start(10);
      await vi.waitFor(() => expect(native.open).toHaveBeenCalledOnce());
      const destination = new URL(native.open.mock.calls[0][0]);
      expect(destination.origin).toBe('https://accounts.google.com');
      expect(destination.pathname).toBe('/o/oauth2/v2/auth');
      expect(destination.searchParams.get('scope')?.split(' ')).toContain(
        'https://www.googleapis.com/auth/spreadsheets.readonly'
      );
      expect(controller.cancel(id, 10)).toBe(true);
      expect(native.secureStorage).not.toHaveBeenCalled();
    } finally {
      await controller.dispose();
    }
  });
});

describe('packaged Google Sheets configuration', () => {
  it('reads the dedicated built-in registration without opening the browser or keychain', async () => {
    native.isPackaged = true;
    vi.stubGlobal(
      '__DNAFORGE_GOOGLE_SHEETS_DESKTOP_CLIENT_ID__',
      'synthetic.apps.googleusercontent.com'
    );
    const controller = createNativeGoogleSheetsController();
    try {
      expect((await controller.status()).configured).toBe(true);
      expect(native.secureStorage).not.toHaveBeenCalled();
      expect(native.open).not.toHaveBeenCalled();
    } finally {
      await controller.dispose();
    }
  });

  it.each(['', 'malformed-client'])(
    'rejects missing or invalid packaged registration despite a development config: %s',
    async (registration) => {
      native.isPackaged = true;
      native.config.set(
        'DNAFORGE_GOOGLE_SHEETS_DESKTOP_CLIENT_ID',
        'synthetic.apps.googleusercontent.com'
      );
      vi.stubGlobal('__DNAFORGE_GOOGLE_SHEETS_DESKTOP_CLIENT_ID__', registration);
      const controller = createNativeGoogleSheetsController();
      try {
        expect((await controller.status()).configured).toBe(false);
        await expect(controller.start(1)).rejects.toMatchObject({ reason: 'unavailable' });
        expect(native.open).not.toHaveBeenCalled();
      } finally {
        await controller.dispose();
      }
    }
  );
});
