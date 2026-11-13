// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  isAbsoluteFilesystemPath,
  joinFilesystemPath,
  resolveAlignmentQueryPath,
} from './alignment-query-path';

describe('resolveAlignmentQueryPath', () => {
  it('joins a sidecar filename to the reference directory', () => {
    expect(
      resolveAlignmentQueryPath(
        'clone-1-verified.fasta',
        '/Users/lab/samples/alignments/clone-verification/reference.gb'
      )
    ).toBe('/Users/lab/samples/alignments/clone-verification/clone-1-verified.fasta');
  });

  it('leaves an already-absolute POSIX path unchanged', () => {
    expect(resolveAlignmentQueryPath('/abs/clone-2.fasta', '/Users/lab/samples/reference.gb')).toBe(
      '/abs/clone-2.fasta'
    );
  });

  it('joins against a Windows reference path', () => {
    expect(resolveAlignmentQueryPath('clone-3.fasta', 'C:\\lab\\alignments\\reference.gb')).toBe(
      'C:\\lab\\alignments\\clone-3.fasta'
    );
  });

  it('leaves an already-absolute Windows path unchanged', () => {
    expect(
      resolveAlignmentQueryPath('D:\\reads\\clone.ab1', 'C:\\lab\\alignments\\reference.gb')
    ).toBe('D:\\reads\\clone.ab1');
  });

  it('returns an empty string unchanged', () => {
    expect(resolveAlignmentQueryPath('   ', '/ref.gb')).toBe('');
  });

  it('returns the query unchanged when the reference has no directory', () => {
    expect(resolveAlignmentQueryPath('clone.fasta', 'reference.gb')).toBe('clone.fasta');
  });
});

describe('isAbsoluteFilesystemPath / joinFilesystemPath', () => {
  it('treats UNC paths as absolute', () => {
    expect(isAbsoluteFilesystemPath('\\\\nas\\reads\\clone.fasta')).toBe(true);
  });

  it('uses backslash when the directory is Windows-shaped', () => {
    expect(joinFilesystemPath('C:\\lab\\alignments', 'a.fa')).toBe('C:\\lab\\alignments\\a.fa');
  });
});
