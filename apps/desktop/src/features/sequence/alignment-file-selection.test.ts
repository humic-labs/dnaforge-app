// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  collectAlignmentQueryPathsFromFiles,
  isAlignmentQueryPath,
  pendingAlignmentFilesFromSelection,
} from './alignment-file-selection';

describe('pendingAlignmentFilesFromSelection', () => {
  it('maps a selected file path to pending alignment file metadata', () => {
    expect(pendingAlignmentFilesFromSelection('/runs/clone-1.ab1')).toEqual([
      { path: '/runs/clone-1.ab1', name: 'clone-1.ab1' },
    ]);
  });

  it('supports multiple selected files and Windows path separators', () => {
    expect(
      pendingAlignmentFilesFromSelection(['/runs/clone-1.ab1', 'C:\\runs\\clone-2.seq'])
    ).toEqual([
      { path: '/runs/clone-1.ab1', name: 'clone-1.ab1' },
      { path: 'C:\\runs\\clone-2.seq', name: 'clone-2.seq' },
    ]);
  });

  it('keeps existing files and dedupes repeated selections', () => {
    const existing = [{ path: '/runs/clone-1.ab1', name: 'clone-1.ab1' }];

    expect(
      pendingAlignmentFilesFromSelection(['/runs/clone-1.ab1', '/runs/clone-2.ab1'], existing)
    ).toEqual([
      { path: '/runs/clone-1.ab1', name: 'clone-1.ab1' },
      { path: '/runs/clone-2.ab1', name: 'clone-2.ab1' },
    ]);
  });

  it('leaves the pending list unchanged when the dialog is cancelled', () => {
    const existing = [{ path: '/runs/clone-1.ab1', name: 'clone-1.ab1' }];

    expect(pendingAlignmentFilesFromSelection(null, existing)).toBe(existing);
  });

  it('falls back to the full path when the path ends with a separator', () => {
    expect(pendingAlignmentFilesFromSelection('/runs/clone-1/')).toEqual([
      { path: '/runs/clone-1/', name: '/runs/clone-1/' },
    ]);

    expect(pendingAlignmentFilesFromSelection('C:\\runs\\clone-2\\')).toEqual([
      { path: 'C:\\runs\\clone-2\\', name: 'C:\\runs\\clone-2\\' },
    ]);
  });
});

describe('isAlignmentQueryPath', () => {
  it('accepts sequencing extensions used by the Alignments picker', () => {
    expect(isAlignmentQueryPath('/runs/clone-1.fasta')).toBe(true);
    expect(isAlignmentQueryPath('C:\\runs\\clone-2.ab1')).toBe(true);
    expect(isAlignmentQueryPath('read.fastq')).toBe(true);
  });

  it('rejects non-sequence files', () => {
    expect(isAlignmentQueryPath('/notes/readme.md')).toBe(false);
    expect(isAlignmentQueryPath('/img/photo.png')).toBe(false);
  });
});

describe('collectAlignmentQueryPathsFromFiles', () => {
  it('keeps only sequencing files with a native path', () => {
    const fasta = new File(['ATGC'], 'clone.fasta');
    const png = new File(['x'], 'photo.png');
    const paths = collectAlignmentQueryPathsFromFiles([fasta, png], (file) =>
      file.name === 'clone.fasta' ? '/runs/clone.fasta' : '/img/photo.png'
    );
    expect(paths).toEqual(['/runs/clone.fasta']);
  });

  it('skips dropped files that have no filesystem path', () => {
    const fasta = new File(['ATGC'], 'clone.fasta');
    expect(collectAlignmentQueryPathsFromFiles([fasta], () => '')).toEqual([]);
  });

  it('dedupes repeated files', () => {
    const a = new File(['ATGC'], 'clone.fasta');
    const b = new File(['ATGC'], 'clone.fasta');
    const paths = collectAlignmentQueryPathsFromFiles([a, b], () => '/runs/clone.fasta');
    expect(paths).toEqual(['/runs/clone.fasta']);
  });
});
