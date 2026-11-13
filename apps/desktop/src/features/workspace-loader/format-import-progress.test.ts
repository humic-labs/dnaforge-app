import { describe, it, expect } from 'vitest';
import { formatImportProgress } from './format-import-progress';
import type { PendingImport } from '../../stores/workspaceStore';

const base: PendingImport = {
  id: 'i',
  originPath: '/x',
  displayName: 'x',
  kind: 'folder',
  status: 'scanning',
};

describe('formatImportProgress ', () => {
  it('shows indeterminate text for scanning / finalizing', () => {
    expect(formatImportProgress({ ...base, status: 'scanning' })).toBe('scanning…');
    expect(formatImportProgress({ ...base, status: 'finalizing' })).toBe('finalizing…');
  });

  it('shows determinate percent + counts while copying with totals', () => {
    expect(
      formatImportProgress({ ...base, status: 'copying', filesCopied: 123, totalFiles: 270 })
    ).toBe('copying… 45% (123/270)');
    expect(
      formatImportProgress({ ...base, status: 'copying', filesCopied: 6, totalFiles: 6 })
    ).toBe('copying… 100% (6/6)');
  });

  it('falls back to bare copying when totals are unknown', () => {
    expect(formatImportProgress({ ...base, status: 'copying' })).toBe('copying…');
    expect(
      formatImportProgress({ ...base, status: 'copying', filesCopied: 1, totalFiles: 0 })
    ).toBe('copying…');
  });
});
