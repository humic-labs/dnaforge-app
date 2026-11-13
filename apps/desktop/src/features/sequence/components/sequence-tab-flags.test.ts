// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  sequenceTabCoordinateSpace,
  sequenceTabDiffViewActive,
  sequenceTabGitCommitFile,
  sequenceTabIsCircular,
  sequenceTabManagedDocument,
  sequenceTabPrimerSaveDir,
} from './sequence-tab-flags';

describe('sequenceTabManagedDocument', () => {
  it('keeps only managed-sequence document refs', () => {
    expect(sequenceTabManagedDocument({ kind: 'managed-sequence' })?.kind).toBe('managed-sequence');
    expect(sequenceTabManagedDocument({ kind: 'loose-file' })).toBeUndefined();
  });
});

describe('sequenceTabPrimerSaveDir', () => {
  it('uses the visible sequence package location instead of its private GenBank member', () => {
    expect(
      sequenceTabPrimerSaveDir(
        { kind: 'managed-sequence', packageId: 'pBR322', packageRoot: '/lab/sequences/pBR322' },
        '/lab/sequences/pBR322/.forge/sequence.gb'
      )
    ).toBe('/lab/sequences');
  });

  it('uses the containing folder for cataloged files, including Windows paths', () => {
    expect(sequenceTabPrimerSaveDir(undefined, '/lab/sequences/pBR322.gb')).toBe('/lab/sequences');
    expect(sequenceTabPrimerSaveDir(undefined, 'C:\\lab\\sequences\\pBR322.gb')).toBe(
      'C:\\lab\\sequences'
    );
  });
});

describe('sequenceTabGitCommitFile / circular / coordinate space', () => {
  it('hides git commit files in read-only and coalesces coordinate spaces', () => {
    expect(sequenceTabGitCommitFile(true, '/tmp/x.gb')).toBeNull();
    expect(sequenceTabGitCommitFile(false, '/tmp/x.gb')).toBe('/tmp/x.gb');
    expect(sequenceTabIsCircular(undefined)).toBe(false);
    expect(sequenceTabIsCircular(true)).toBe(true);
    expect(sequenceTabDiffViewActive(false, null)).toBe(false);
    expect(sequenceTabDiffViewActive(false, {})).toBe(true);
    expect(sequenceTabCoordinateSpace(undefined, 'head', 'git')).toBe('head');
    expect(sequenceTabCoordinateSpace('live', 'head', 'git')).toBe('live');
  });
});
