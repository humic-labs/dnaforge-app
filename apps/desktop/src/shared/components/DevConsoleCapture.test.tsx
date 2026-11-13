import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  writeTextFile: vi.fn(async () => {
    throw new Error('PROJECT_FILESYSTEM_AUTHORITY_REQUIRED: refused');
  }),
  mkdir: vi.fn(async () => undefined),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fs: { writeTextFile: bridge.writeTextFile, mkdir: bridge.mkdir },
    path: { appDataDir: async () => '/app-data' },
  }),
}));

import { DevConsoleCapture } from './DevConsoleCapture';

afterEach(() => {
  cleanup();
});

it('stops after a refused log write without retitling the window or keeping the lines', async () => {
  document.title = 'DNAForge';
  render(<DevConsoleCapture />);

  for (let line = 0; line < 12; line += 1) console.info(`line ${line}`);
  await waitFor(() => expect(bridge.writeTextFile).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(window.__devConsoleState?.logBuffer).toEqual([]));

  for (let line = 0; line < 30; line += 1) console.info(`later ${line}`);
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(bridge.writeTextFile).toHaveBeenCalledTimes(1);
  expect(window.__devConsoleState?.logBuffer).toEqual([]);
  expect(document.title).toBe('DNAForge');
});
