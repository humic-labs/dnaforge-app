import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sequencePackagePaths } from '../db/sequence-package';
import { packageRootForLockedSequenceMarkerReplace } from './sequence-package-marker-lock';

describe('sequence marker lock routing', () => {
  const workspaceRoot = resolve('/workspace/project');
  const packageRoot = resolve(workspaceRoot, 'construct');
  const markerPath = sequencePackagePaths(packageRoot).metaPath;

  it('locks a marker replace when the caller declares the enclosing workspace', () => {
    expect(packageRootForLockedSequenceMarkerReplace(workspaceRoot, markerPath, 'replace')).toBe(
      packageRoot
    );
  });

  it('also locks member registration when the package itself is the declared root', () => {
    expect(packageRootForLockedSequenceMarkerReplace(packageRoot, markerPath, 'replace')).toBe(
      packageRoot
    );
  });

  it('does not classify creates, unrelated files, or a marker outside the declared root', () => {
    expect(
      packageRootForLockedSequenceMarkerReplace(workspaceRoot, markerPath, 'create')
    ).toBeNull();
    expect(
      packageRootForLockedSequenceMarkerReplace(
        workspaceRoot,
        resolve(packageRoot, '.forge', 'other.json'),
        'replace'
      )
    ).toBeNull();
    expect(
      packageRootForLockedSequenceMarkerReplace(
        resolve('/workspace/another-project'),
        markerPath,
        'replace'
      )
    ).toBeNull();
  });
});
