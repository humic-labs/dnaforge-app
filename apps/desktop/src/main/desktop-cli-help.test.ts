// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const native = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock('electron', () => ({
  dialog: { showMessageBox: native.showMessageBox },
  clipboard: { writeText: native.writeText },
}));
import { showDesktopCliHelp } from './desktop-cli-help';

const roots: string[] = [];
afterEach(() => {
  native.showMessageBox.mockReset();
  native.writeText.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([0, 1])(
  'copies the actual installed launcher path only when Copy is chosen (%i)',
  async (response) => {
    const resourcesPath = mkdtempSync(join(tmpdir(), 'dnaforge-cli-help-'));
    roots.push(resourcesPath);
    mkdirSync(join(resourcesPath, 'cli'));
    const launcher = join(
      resourcesPath,
      'cli',
      process.platform === 'win32' ? 'dnaforge.cmd' : 'dnaforge'
    );
    writeFileSync(launcher, 'bundled launcher');
    native.showMessageBox.mockResolvedValueOnce({ response });
    const window = {} as BrowserWindow;
    await showDesktopCliHelp(window, resourcesPath);
    expect(native.showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        detail: expect.stringContaining(launcher),
        buttons: ['Copy path', 'Close'],
      })
    );
    if (response === 0) expect(native.writeText).toHaveBeenCalledWith(launcher);
    else expect(native.writeText).not.toHaveBeenCalled();
  }
);

it('reports a missing bundled command without copying a nonfunctional path', async () => {
  const resourcesPath = mkdtempSync(join(tmpdir(), 'dnaforge-cli-help-missing-'));
  roots.push(resourcesPath);
  native.showMessageBox.mockResolvedValueOnce({ response: 0 });
  await showDesktopCliHelp({} as BrowserWindow, resourcesPath);
  expect(native.showMessageBox).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      type: 'error',
    })
  );
  expect(native.writeText).not.toHaveBeenCalled();
});
