import { toUserMessage } from '@waypoint/user-messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const input = vi.hoisted(() => ({ text: '' }));
vi.mock('../../sequence/public/utils/guarded-read', () => ({
  readSequenceFileGuarded: vi.fn(async () => input.text),
}));
vi.mock('../../../platform', () => ({ platform: () => ({ fs: { readFile: vi.fn() } }) }));

import { readSequenceFile } from './alignment-api';

describe('alignment input record count', () => {
  beforeEach(() => {
    input.text = '';
  });

  it('does not report a multi-read FASTQ sample as its first read', async () => {
    input.text =
      '@read-one\nACGTACGTACGT\n+\nIIIIIIIIIIII\n@read-two\nACGTTCGTACGT\n+\nIIIIIIIIIIII\n';
    await expect(readSequenceFile('/sample/clone.fastq')).rejects.toThrow(/2 sequences/);
  });

  it('shows the multi-read refusal through the alignment alert', async () => {
    input.text =
      '@read-one\nACGTACGTACGT\n+\nIIIIIIIIIIII\n@read-two\nACGTTCGTACGT\n+\nIIIIIIIIIIII\n';
    const error = await readSequenceFile('/sample/clone.fastq').then(
      () => {
        throw new Error('expected the multi-read file to be refused');
      },
      (caught: unknown) => caught
    );
    const message = error instanceof Error ? error.message : String(error);
    const shown = toUserMessage(message, 'alignment.failed');
    expect(shown).toContain('clone.fastq contains 2 sequences');
    expect(shown).toContain('multi-read samples require NGS analysis');
    expect(shown).not.toBe(
      'We couldn’t complete this alignment action. Check your inputs and try again.'
    );
  });

  it('does not silently drop later FASTA records', async () => {
    input.text = '>clone-one\nACGTACGTACGT\n>clone-two\nACGTTCGTACGT\n';
    await expect(readSequenceFile('/sample/clones.fasta')).rejects.toThrow(/2 sequences/);
  });

  it('reads a single clone sequence through the same parser', async () => {
    input.text = '>clone-one\nACGTACGTACGT\n';
    await expect(readSequenceFile('/sample/clone.fasta')).resolves.toBe('ACGTACGTACGT');
  });
});
