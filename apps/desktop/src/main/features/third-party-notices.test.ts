// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/missing-app' },
  shell: { openPath: vi.fn(async () => '') },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  ipcRenderer: {},
}));

import {
  CHROMIUM_LICENSES_FILE,
  THIRD_PARTY_NOTICES_FILE,
  appResourceFile,
  readThirdPartyNotices,
  registerThirdPartyNoticesIpc,
} from './third-party-notices';

const coverage = createRequire(import.meta.url)('../../../scripts/third-party-coverage.cjs') as {
  NOTICES_FILE: string;
  CHROMIUM_LICENSES_FILE: string;
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'third-party-notices-'));
  ipc.handlers.clear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function packagedAt(resourcesPath: string) {
  return { isPackaged: true, resourcesPath, appPath: join(root, 'app.asar') };
}

describe('third-party notices in main', () => {
  it('names the same files that packaging writes', () => {
    expect(THIRD_PARTY_NOTICES_FILE).toBe(coverage.NOTICES_FILE);
    expect(CHROMIUM_LICENSES_FILE).toBe(coverage.CHROMIUM_LICENSES_FILE);
  });

  it('reads packaged resources, and the desktop resources folder in development', () => {
    expect(appResourceFile('a.md', packagedAt('/Resources'))).toBe(join('/Resources', 'a.md'));
    const appPath = join(root, 'apps/desktop/out/main');
    const devFile = join(root, 'apps/desktop/resources/a.md');
    mkdirSync(join(root, 'apps/desktop/resources'), { recursive: true });
    writeFileSync(devFile, 'x');
    const location = { isPackaged: false, resourcesPath: '/unused', appPath };
    expect(appResourceFile('a.md', location)).toBe(devFile);
    expect(appResourceFile('missing.md', location)).toBe(join(appPath, 'resources', 'missing.md'));
  });

  it('returns the notices text, and reports a missing or empty file as unavailable', async () => {
    const location = packagedAt(root);
    await expect(readThirdPartyNotices(location)).resolves.toEqual({ status: 'unavailable' });
    writeFileSync(join(root, THIRD_PARTY_NOTICES_FILE), '  \n');
    await expect(readThirdPartyNotices(location)).resolves.toEqual({ status: 'unavailable' });
    writeFileSync(
      join(root, THIRD_PARTY_NOTICES_FILE),
      '# Third-party notices for DNAForge 1.0.0\n'
    );
    await expect(readThirdPartyNotices(location)).resolves.toEqual({
      status: 'available',
      text: '# Third-party notices for DNAForge 1.0.0\n',
    });
  });

  it('opens the Chromium license list only when the packaged file exists', async () => {
    const openPath = vi.fn(async () => '');
    const dispose = registerThirdPartyNoticesIpc(() => packagedAt(root), openPath);
    const open = ipc.handlers.get('thirdPartyNotices:openChromiumLicenses')!;
    await expect(open({})).resolves.toBe(false);
    expect(openPath).not.toHaveBeenCalled();
    writeFileSync(join(root, CHROMIUM_LICENSES_FILE), '<html></html>');
    await expect(open({})).resolves.toBe(true);
    expect(openPath).toHaveBeenCalledWith(join(root, CHROMIUM_LICENSES_FILE));
    openPath.mockResolvedValueOnce('No application knows how to open this file');
    await expect(open({})).resolves.toBe(false);
    writeFileSync(join(root, THIRD_PARTY_NOTICES_FILE), 'notices');
    await expect(ipc.handlers.get('thirdPartyNotices:read')!({})).resolves.toEqual({
      status: 'available',
      text: 'notices',
    });
    dispose();
    expect(ipc.handlers.has('thirdPartyNotices:read')).toBe(false);
  });
});
