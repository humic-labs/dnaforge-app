// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  resolveExplicitProjectRoot,
  resolveMountedProjectRoot,
  uniquelyNamedProjectRoot,
} from './project-root-selection';

const roots = [
  { path: '/projects/one', name: 'Shared', addedAt: 1 },
  { path: '/projects/two', name: 'Shared', addedAt: 2 },
  { path: '/projects/three', name: 'Unique', addedAt: 3 },
];

describe('project root selection', () => {
  it('refuses duplicate display names instead of selecting the first mounted project', () => {
    expect(uniquelyNamedProjectRoot(roots, 'shared')).toBeNull();
    expect(resolveExplicitProjectRoot(roots, 'Shared')).toBeNull();
  });

  it('resolves a unique display name case-insensitively', () => {
    expect(uniquelyNamedProjectRoot(roots, 'unique')?.path).toBe('/projects/three');
  });

  it('prefers an exact stable path even when project display names collide', () => {
    expect(resolveExplicitProjectRoot(roots, '/projects/two')?.path).toBe('/projects/two');
  });

  it('refuses a duplicated selected project path in either mount order', () => {
    const duplicates = [
      { path: '/projects/one', name: 'First' },
      { path: '/projects/one/', name: 'Second' },
    ];

    expect(resolveMountedProjectRoot(duplicates, '/projects/one')).toBeNull();
    expect(resolveMountedProjectRoot([...duplicates].reverse(), '/projects/one')).toBeNull();
    expect(resolveExplicitProjectRoot(duplicates, '/projects/one')).toBeNull();
  });
});
