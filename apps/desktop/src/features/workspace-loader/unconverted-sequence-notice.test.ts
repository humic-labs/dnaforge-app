import { beforeEach, describe, expect, it, vi } from 'vitest';

const addToast = vi.hoisted(() => vi.fn());
vi.mock('../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addToast }) },
}));

import {
  reportUnconvertedSequenceFiles,
  unconvertedSequenceMessage,
} from './unconverted-sequence-notice';

const file = (relPath: string) => ({ relPath, reason: 'refused' });

describe('unconverted sequence notice ', () => {
  beforeEach(() => addToast.mockClear());

  it('says nothing when every file converted', () => {
    expect(unconvertedSequenceMessage(undefined)).toBeNull();
    expect(unconvertedSequenceMessage([])).toBeNull();
    reportUnconvertedSequenceFiles([]);
    expect(addToast).not.toHaveBeenCalled();
  });

  it('names one file in the singular', () => {
    expect(unconvertedSequenceMessage([file('nested/enzyme.fasta')])).toBe(
      '1 sequence file was kept as plain files: enzyme.fasta. Open one to see why and convert it.'
    );
  });

  it('names the first three files and counts the rest', () => {
    reportUnconvertedSequenceFiles(['a.fa', 'b/b.fa', 'c.fa', 'd.fa', 'e.fa'].map(file));
    expect(addToast).toHaveBeenCalledWith(
      '5 sequence files were kept as plain files: a.fa, b.fa, c.fa and 2 more. Open one to see why and convert it.',
      { definition: 'workspace-loader-unconverted-sequence-files' }
    );
  });
});
