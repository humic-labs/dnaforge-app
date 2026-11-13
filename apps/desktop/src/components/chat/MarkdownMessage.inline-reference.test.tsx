import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { buildInlineTextDocument } from '../../features/ai/references/inline/document';
import { MarkdownMessage } from './MarkdownMessage';

const source =
  'Open [pUC19](dnaforge-chat://entity/sequence/Research%20Workspace/constructs/pUC19.gb) now.';

describe('MarkdownMessage inline references', () => {
  it('renders a resolved typed part at its exact prose position without a private href', () => {
    const document = buildInlineTextDocument(source, { streaming: false });
    document.parts[0] = {
      ...document.parts[0],
      state: {
        status: 'resolved',
        canonicalLabel: 'pUC19.gb',
        referenceId: '5887a64e-1234-4678-9abc-def012345678',
      },
    };

    const { container } = render(
      <MarkdownMessage
        content={source}
        document={document}
        renderInlineReference={(part) => <button type="button">{part.label}</button>}
      />
    );

    expect(screen.getByRole('button', { name: 'pUC19' })).toBeInTheDocument();
    expect(container.querySelector('p')).toHaveTextContent('Open pUC19 now.');
    expect(container.querySelector('[href^="dnaforge-chat:"]')).toBeNull();
    expect(container.innerHTML).not.toContain('dnaforge-chat://');
  });

  it('shows only the readable label while a streamed declaration is incomplete', () => {
    const partial = 'Open [pUC19](dnaforge-chat://entity/sequence/Research%20Workspace/constructs';
    const { container } = render(<MarkdownMessage content={partial} streaming />);

    expect(container).toHaveTextContent('Open pUC19');
    expect(container.innerHTML).not.toContain('dnaforge-chat://');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps a complete but unresolved declaration readable and inert', () => {
    const { container } = render(<MarkdownMessage content={source} streaming />);

    expect(container.querySelector('p')).toHaveTextContent('Open pUC19 now.');
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.innerHTML).not.toContain('dnaforge-chat://');
  });

  it('keeps private protocol bytes out of code, escaped text, and malformed links', () => {
    const content = [
      '`[inline](dnaforge-chat://workspace/root/file.gb)`',
      '~~~text\n[fenced](dnaforge-chat://workspace/root/file.gb)\n~~~',
      '\\[escaped\\]\\(dnaforge-chat://workspace/root/file.gb\\)',
      '[traversal](dnaforge-chat://workspace/root/..)',
    ].join('\n\n');
    const { container } = render(<MarkdownMessage content={content} />);

    expect(container.textContent).not.toContain('dnaforge-chat://');
    expect(container.innerHTML).not.toContain('dnaforge-chat://');
    expect(container.querySelector('[href^="dnaforge-chat:"]')).toBeNull();
  });

  it('keeps code and inert paths neutral while ordinary web links retain link styling', () => {
    render(
      <MarkdownMessage
        content={'`const x = 1` [local file](relative/path) [docs](https://example.com)'}
      />
    );

    expect(screen.getByText('const x = 1')).toHaveClass('text-fg');
    expect(screen.getByText('const x = 1')).not.toHaveClass('text-accent');
    expect(screen.getByText('local file')).toHaveClass('text-fg');
    expect(screen.getByText('local file')).not.toHaveClass('text-accent');
    expect(screen.getByRole('link', { name: 'docs' })).toHaveClass('text-accent', 'underline');
  });
});
