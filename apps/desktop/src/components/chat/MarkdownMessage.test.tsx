import { render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkdownMessage } from './MarkdownMessage';
import { FormattedMessage, type ReferenceResolutionStatus } from './MessageFormatting';
import { containsGfmTable, splitMarkdownBlocks } from './markdown-blocks';

vi.mock('react-markdown', () => ({
  default: vi.fn(({ children }: { children: string }) => <div>{children}</div>),
  defaultUrlTransform: (url: string) => url,
}));

describe('splitMarkdownBlocks', () => {
  it('commits blank-line-delimited prefixes and leaves only the live tail mutable', () => {
    expect(splitMarkdownBlocks('First paragraph.\n\nSecond paragraph')).toEqual([
      {
        key: 'markdown-block-0',
        source: 'First paragraph.\n\n',
        completed: true,
        startOffset: 0,
        endOffset: 18,
      },
      {
        key: 'markdown-block-1',
        source: 'Second paragraph',
        completed: false,
        startOffset: 18,
        endOffset: 34,
      },
    ]);
  });

  it('does not split on blank lines inside a fenced code block', () => {
    const source = '```python\nprint("a")\n\nprint("b")\n```\n\nTail';
    const blocks = splitMarkdownBlocks(source);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].source).toBe('```python\nprint("a")\n\nprint("b")\n```\n\n');
    expect(blocks[1].source).toBe('Tail');
  });

  it('does not treat trailing text after a fence marker as a closing fence', () => {
    const source = '```text\ninside\n```not-a-close\n\nstill code\n```\n\nTail';
    const blocks = splitMarkdownBlocks(source);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].source).toBe('```text\ninside\n```not-a-close\n\nstill code\n```\n\n');
    expect(blocks[1].source).toBe('Tail');
  });
});

describe('containsGfmTable', () => {
  it('recognizes the GFM table shape rendered by the markdown pipeline', () => {
    expect(
      containsGfmTable(['| Enzyme | Cuts |', '| --- | ---: |', '| EcoRI | 1 |'].join('\n'))
    ).toBe(true);
  });

  it('ignores table-like source inside a fenced code block', () => {
    expect(
      containsGfmTable(['```markdown', '| Enzyme | Cuts |', '| --- | ---: |', '```'].join('\n'))
    ).toBe(false);
  });
});

describe('MarkdownMessage streaming memoization', () => {
  beforeEach(() => {
    vi.mocked(ReactMarkdown).mockClear();
  });

  it('parses a completed prefix exactly once while the trailing block grows', () => {
    const { rerender } = render(
      <MarkdownMessage content={'Completed paragraph.\n\nTrailing'} streaming />
    );
    expect(vi.mocked(ReactMarkdown)).toHaveBeenCalledTimes(2);

    rerender(<MarkdownMessage content={'Completed paragraph.\n\nTrailing grows'} streaming />);

    expect(vi.mocked(ReactMarkdown)).toHaveBeenCalledTimes(3);
  });

  it('parses a persisted message as one complete CommonMark document', () => {
    render(<MarkdownMessage content={'Paragraph.\n\n[link]: https://example.com'} />);

    expect(vi.mocked(ReactMarkdown)).toHaveBeenCalledTimes(1);
  });
});

describe('FormattedMessage history memoization', () => {
  it('does not re-resolve stable historical attachments when the parent re-renders', () => {
    const referenceId = '5887a64e-1234-5678-9abc-def012345678';
    const getResolution = vi.fn((): ReferenceResolutionStatus => 'loading');
    const referenceResolution = {
      get: getResolution,
    } as unknown as ReadonlyMap<string, ReferenceResolutionStatus>;
    const references = new Map();
    const referenceIds = [referenceId];

    const { rerender } = render(
      <FormattedMessage
        content="Stable historical response"
        references={references}
        referenceIds={referenceIds}
        referenceResolution={referenceResolution}
      />
    );
    expect(getResolution).toHaveBeenCalledTimes(1);

    rerender(
      <FormattedMessage
        content="Stable historical response"
        references={references}
        referenceIds={referenceIds}
        referenceResolution={referenceResolution}
      />
    );

    expect(getResolution).toHaveBeenCalledTimes(1);
  });
});
