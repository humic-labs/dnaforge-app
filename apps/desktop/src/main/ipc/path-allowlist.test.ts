import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { isPathInsideBoundary } from '../../shared/path-boundary';

describe('IPC path allowlist helpers', () => {
  it('allows descendants and the root itself', () => {
    const root = join('tmp', 'dnaforge-root');

    expect(isPathInsideBoundary(root, root)).toBe(true);
    expect(isPathInsideBoundary(join(root, 'Sample Workspaces', 'standard-samples'), root)).toBe(
      true
    );
  });

  it('rejects sibling paths that only share a string prefix', () => {
    const root = join('tmp', 'dnaforge-root');

    expect(isPathInsideBoundary(join('tmp', 'dnaforge-root-evil', 'workspace'), root)).toBe(false);
  });

  it('allows child names that start with two dots without treating them as traversal', () => {
    const root = join('tmp', 'dnaforge-root');

    expect(isPathInsideBoundary(join(root, '..literal-name'), root)).toBe(true);
  });

  it('allows installed Windows sample workspaces under the user profile', () => {
    const home = 'C:\\Users\\user';
    const workspace =
      'C:\\Users\\user\\AppData\\Roaming\\DNAForge\\Sample Workspaces\\standard-samples\\v1\\workspace';

    expect(isPathInsideBoundary(workspace, home, { platform: 'win32' })).toBe(true);
  });
});
