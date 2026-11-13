import { describe, expect, it } from 'vitest';
import {
  RICH_SEQUENCE_CLIPBOARD_FORMAT,
  RICH_SEQUENCE_CLIPBOARD_VERSION,
  type RichSequenceFragment,
} from '../sequence-clipboard/public/rich-sequence-clipboard';
import { copiedSequenceForChatPaste } from './copied-sequence-paste';

function fragment(overrides: Partial<RichSequenceFragment> = {}): RichSequenceFragment {
  return {
    format: RICH_SEQUENCE_CLIPBOARD_FORMAT,
    version: RICH_SEQUENCE_CLIPBOARD_VERSION,
    sequence: 'ATGC',
    sourceId: 'doc-puc19',
    sourceName: 'pUC19.gb',
    start: 10,
    end: 14,
    annotations: [],
    primerBindings: [],
    sourceCoordinates: { start: 10, end: 13 },
    sourceWorkspaceRoot: '/tmp/project',
    ...overrides,
  };
}

describe('copiedSequenceForChatPaste', () => {
  it('returns the in-app copy when the pasted text is that sequence', () => {
    const copied = fragment();
    expect(copiedSequenceForChatPaste('ATGC', copied)).toBe(copied);
    expect(copiedSequenceForChatPaste('  ATGC\n', copied)?.sourceCoordinates).toEqual({
      start: 10,
      end: 13,
    });
  });

  it('leaves a different paste as text', () => {
    expect(copiedSequenceForChatPaste('AAAA', fragment())).toBeNull();
    expect(copiedSequenceForChatPaste('ATGC', null)).toBeNull();
  });

  it('does not chip a copy that has no source coordinates', () => {
    expect(
      copiedSequenceForChatPaste('ATGC', fragment({ sourceCoordinates: undefined }))
    ).toBeNull();
  });

  it('does not chip an external clipboard fragment', () => {
    expect(
      copiedSequenceForChatPaste('ATGC', fragment({ sourceId: 'clipboard:plain-dna' }))
    ).toBeNull();
  });
});
