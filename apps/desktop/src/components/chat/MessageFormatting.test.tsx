import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { extractMessageReferences, FormattedMessage } from './MessageFormatting';
import type { DBEntityReference } from '../../db/entity-references';
import { buildInlineTextDocument } from '../../features/ai/references/inline/document';

beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});

const UUID_A = '5887a64e-1234-5678-9abc-def012345678';
const UUID_B = '12345678-abcd-ef01-2345-678901234567';

function makeRef(id: string, label: string): DBEntityReference {
  return {
    id,
    entity_type: 'sequence_region',
    display_label: label,
    locator: 'git://workspace/plasmids/pUC19.gb',
    deep_link_params: null,
    data: null,
    source: 'user',
    status: 'created',
    created_at: 0,
    updated_at: 0,
  };
}

describe('extractMessageReferences', () => {
  it('pulls UUID reference ids out of the prose', () => {
    const { prose, referenceIds } = extractMessageReferences(
      `What is this region?\n\n[[ref:${UUID_A}]]`
    );
    expect(referenceIds).toEqual([UUID_A]);
    expect(prose).toBe('What is this region?');
    expect(prose).not.toContain('[[ref:');
  });

  it('collects multiple distinct ids in first-seen order and de-dupes', () => {
    const { prose, referenceIds } = extractMessageReferences(
      `Compare these\n\n[[ref:${UUID_A}]] [[ref:${UUID_B}]] [[ref:${UUID_A}]]`
    );
    expect(referenceIds).toEqual([UUID_A, UUID_B]);
    expect(prose).toBe('Compare these');
  });

  it('yields empty prose when the message is only references', () => {
    const { prose, referenceIds } = extractMessageReferences(`[[ref:${UUID_A}]]`);
    expect(referenceIds).toEqual([UUID_A]);
    expect(prose).toBe('');
  });

  it('strips a legacy "Referenced entities:" caption left by old messages', () => {
    const { prose, referenceIds } = extractMessageReferences(
      `Analyze this plasmid\n\nReferenced entities: [[ref:${UUID_A}]] [[ref:${UUID_B}]]`
    );
    expect(referenceIds).toEqual([UUID_A, UUID_B]);
    expect(prose).toBe('Analyze this plasmid');
    expect(prose).not.toContain('Referenced entities:');
    expect(prose).not.toContain('[[ref:');
  });

  it('drops malformed / model-authored tokens without yielding an id', () => {
    const { prose, referenceIds } = extractMessageReferences('See [[ref:ref_1]] here');
    expect(referenceIds).toEqual([]);
    expect(prose).not.toContain('[[ref:');
    expect(prose).toContain('See');
    expect(prose).toContain('here');
  });

  it('drops legacy pipe-delimited inline tokens without yielding an id', () => {
    const { referenceIds, prose } = extractMessageReferences(
      '[[ref:rubisco|Rubisco Region|data/rubisco.gb|sequence]]'
    );
    expect(referenceIds).toEqual([]);
    expect(prose).not.toContain('[[ref:');
  });

  it('returns plain content untouched when there are no reference tokens', () => {
    const original = 'Just a normal message.\n\nWith two paragraphs.\n';
    const { prose, referenceIds } = extractMessageReferences(original);
    expect(referenceIds).toEqual([]);
    expect(prose).toBe(original);
  });
});

describe('FormattedMessage — attachments row', () => {
  it('turns a resolved saved-view attachment into one clickable structure preview', () => {
    const reference: DBEntityReference = {
      ...makeRef(UUID_A, 'Saved ligand pocket'),
      entity_type: 'structure',
      locator: 'entity://structure/saved-view:ligand-pocket',
      data: JSON.stringify({
        kind: 'molecular-view',
        version: 1,
        title: 'Saved ligand pocket',
        caption: 'The authored scene and camera.',
        scene: '{"root":{"kind":"root"},"metadata":{"version":"1"}}',
        coordinates: { format: 'pdb', text: 'HEADER    saved view', sha256: '0'.repeat(64) },
        source: {},
        evidence: [],
        preview: 'data:image/png;base64,iVBORw0KGgo=',
        createdAt: 1,
      }),
    };
    const onReferenceClick = vi.fn();
    const props = {
      content: 'Here is the binding pocket.',
      role: 'assistant' as const,
      referenceIds: [UUID_A],
      onReferenceClick,
    };
    const { rerender } = render(<FormattedMessage {...props} references={new Map()} />);
    expect(screen.getByTestId(`ref-chip-loading-${UUID_A}`)).toBeInTheDocument();

    rerender(<FormattedMessage {...props} references={new Map([[UUID_A, reference]])} />);
    const attachments = screen.getByTestId('message-attachments');
    const card = within(attachments).getByTestId(`molecular-view-${UUID_A}`);
    expect(within(card).getAllByRole('img')).toHaveLength(1);
    expect(screen.queryByTestId(`ref-chip-${UUID_A}`)).not.toBeInTheDocument();
    expect(screen.getByText('Here is the binding pocket.')).toBeInTheDocument();
    fireEvent.click(
      within(card).getByRole('button', { name: 'Open saved view: Saved ligand pocket' })
    );
    expect(onReferenceClick).toHaveBeenCalledTimes(1);
    expect(onReferenceClick).toHaveBeenCalledWith(reference);
  });

  it('hides artifact IDs even when an inline document was built from the raw answer', () => {
    const designId = '454b2d2b-5879-4312-b0a8-4e4e5ead6e2e';
    const content = `I saved the design.\nDesign ID: ${designId}\nResource URI: waypoint://design/${designId}`;
    const references = new Map<string, DBEntityReference>([
      [UUID_A, makeRef(UUID_A, 'Example design draft')],
    ]);
    const { container } = render(
      <FormattedMessage
        content={content}
        document={buildInlineTextDocument(content, { streaming: false })}
        references={references}
        referenceIds={[UUID_A]}
      />
    );

    expect(screen.getByTestId(`ref-chip-${UUID_A}`)).toBeInTheDocument();
    expect(container.textContent).toContain('I saved the design.');
    expect(container.textContent).not.toMatch(/Design ID|Resource URI|waypoint:\/\/|454b2d2b/iu);
  });

  it('rebuilds an older inline document after the committed answer is cleaned', () => {
    const designId = '454b2d2b-5879-4312-b0a8-4e4e5ead6e2e';
    const raw = `I saved the design.\nDesign ID: ${designId}`;
    const { container } = render(
      <FormattedMessage
        content="I saved the design."
        document={buildInlineTextDocument(raw, { streaming: false })}
        referenceIds={[]}
      />
    );

    expect(container.textContent).toBe('I saved the design.');
  });

  it('renders carried references as an attachments row of chips, prose stays clean', () => {
    const references = new Map<string, DBEntityReference>([
      [UUID_A, makeRef(UUID_A, 'pUC19.gb 100–500')],
    ]);
    render(
      <FormattedMessage
        content={`What is this region?\n\n[[ref:${UUID_A}]]`}
        references={references}
      />
    );

    const attachments = screen.getByTestId('message-attachments');
    expect(attachments).toBeInTheDocument();
    expect(screen.getByTestId(`ref-chip-${UUID_A}`)).toBeInTheDocument();

    const container = attachments.parentElement as HTMLElement;
    expect(container.textContent).toContain('What is this region?');
    expect(container.textContent).not.toContain('[[ref:');
    expect(container.textContent).not.toContain('Referenced entities:');
  });

  it('renders multiple attached references as chips', () => {
    const references = new Map<string, DBEntityReference>([
      [UUID_A, makeRef(UUID_A, 'Region A')],
      [UUID_B, makeRef(UUID_B, 'Region B')],
    ]);
    render(
      <FormattedMessage
        content={`Compare\n\n[[ref:${UUID_A}]] [[ref:${UUID_B}]]`}
        references={references}
      />
    );
    expect(screen.getByTestId(`ref-chip-${UUID_A}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ref-chip-${UUID_B}`)).toBeInTheDocument();
  });

  it('does NOT render a model-authored token as a chip and never shows it raw', () => {
    const { container } = render(<FormattedMessage content="See [[ref:ref_1]] here" />);
    expect(screen.queryByTestId('message-attachments')).not.toBeInTheDocument();
    expect(container.querySelector('[data-testid^="ref-chip-"]')).toBeNull();
    expect(container.textContent).not.toContain('[[ref:');
    expect(container.textContent).toContain('See');
    expect(container.textContent).toContain('here');
  });

  it('renders a skeleton chip while a carried reference is still loading', () => {
    const { container } = render(
      <FormattedMessage content={`Look here\n\n[[ref:${UUID_A}]]`} references={new Map()} />
    );
    expect(screen.getByTestId('message-attachments')).toBeInTheDocument();
    expect(screen.getByTestId(`ref-chip-loading-${UUID_A}`)).toBeInTheDocument();
    expect(container.textContent).toContain('Look here');
    expect(container.textContent).not.toContain('[[ref:');
  });

  it('renders nothing only after a carried reference is confirmed absent', () => {
    const { container } = render(
      <FormattedMessage
        content={`Look here\n\n[[ref:${UUID_A}]]`}
        references={new Map()}
        referenceResolution={new Map([[UUID_A, 'absent']])}
      />
    );
    expect(screen.queryByTestId('message-attachments')).not.toBeInTheDocument();
    expect(screen.queryByTestId(`ref-chip-loading-${UUID_A}`)).not.toBeInTheDocument();
    expect(container.textContent).toContain('Look here');
    expect(container.textContent).not.toContain('[[ref:');
  });

  it('renders a muted non-interactive chip when reference resolution is unavailable', () => {
    render(
      <FormattedMessage
        content="Look here"
        references={new Map()}
        referenceIds={[UUID_A]}
        referenceResolution={new Map([[UUID_A, 'unavailable']])}
      />
    );

    const unavailable = screen.getByTestId(`ref-chip-unavailable-${UUID_A}`);
    expect(unavailable).toHaveTextContent('Reference unavailable');
    expect(unavailable.tagName).not.toBe('BUTTON');
  });

  it('replaces a legacy-token skeleton with one unavailable chip when the join query fails', () => {
    render(
      <FormattedMessage
        content={`Look here\n\n[[ref:${UUID_A}]]`}
        references={new Map()}
        referenceQueryState="unavailable"
      />
    );

    expect(screen.queryByTestId(`ref-chip-loading-${UUID_A}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`ref-chip-unavailable-${UUID_A}`)).toHaveTextContent(
      'Reference unavailable'
    );
    expect(screen.queryByTestId('message-references-unavailable')).not.toBeInTheDocument();
  });

  it('renders plain markdown unchanged when there are no references', () => {
    const { container } = render(<FormattedMessage content="Hello **world**" />);
    expect(screen.queryByTestId('message-attachments')).not.toBeInTheDocument();
    expect(container.querySelector('strong')?.textContent).toBe('world');
  });
});

describe('FormattedMessage — structured references ', () => {
  it('renders chips from the threaded structured ids over pure-prose content', () => {
    const references = new Map<string, DBEntityReference>([
      [UUID_A, makeRef(UUID_A, 'pUC19.gb 100–500')],
    ]);
    render(
      <FormattedMessage
        content="What is this region?"
        references={references}
        referenceIds={[UUID_A]}
      />
    );

    expect(screen.getByTestId('message-attachments')).toBeInTheDocument();
    expect(screen.getByTestId(`ref-chip-${UUID_A}`)).toBeInTheDocument();

    const attachments = screen.getByTestId('message-attachments');
    const container = attachments.parentElement as HTMLElement;
    expect(container.textContent).toContain('What is this region?');
    expect(container.textContent).not.toContain('[[ref:');
  });

  it('renders multiple structured chips in order', () => {
    const references = new Map<string, DBEntityReference>([
      [UUID_A, makeRef(UUID_A, 'Region A')],
      [UUID_B, makeRef(UUID_B, 'Region B')],
    ]);
    render(
      <FormattedMessage
        content="Compare these"
        references={references}
        referenceIds={[UUID_A, UUID_B]}
      />
    );
    expect(screen.getByTestId(`ref-chip-${UUID_A}`)).toBeInTheDocument();
    expect(screen.getByTestId(`ref-chip-${UUID_B}`)).toBeInTheDocument();
  });

  it('an empty structured ids array renders clean prose with no attachments row', () => {
    const { container } = render(
      <FormattedMessage content="No references here" references={new Map()} referenceIds={[]} />
    );
    expect(screen.queryByTestId('message-attachments')).not.toBeInTheDocument();
    expect(container.textContent).toContain('No references here');
  });

  it('a legacy token still in content (structured [] mode) is stripped, never shown raw', () => {
    const { container } = render(
      <FormattedMessage
        content={`Look\n\n[[ref:${UUID_A}]]`}
        references={new Map()}
        referenceIds={[]}
      />
    );
    expect(container.textContent).not.toContain('[[ref:');
    expect(container.textContent).toContain('Look');
  });

  it('strips legacy tokens even when a supplied inline document owns rendering', () => {
    const content = `Open [pUC19](dnaforge-chat://reference/${UUID_A}).\n\n` + `[[ref:${UUID_A}]]`;
    const document = buildInlineTextDocument(content, { streaming: false });
    document.parts[0] = {
      ...document.parts[0]!,
      state: {
        status: 'resolved',
        canonicalLabel: 'pUC19',
        referenceId: UUID_A,
        reference: makeRef(UUID_A, 'pUC19.gb'),
      },
    };

    const { container } = render(
      <FormattedMessage
        content={content}
        document={document}
        references={new Map([[UUID_A, makeRef(UUID_A, 'pUC19.gb')]])}
        referenceIds={[UUID_A]}
        renderInlineReference={(part) => <button type="button">{part.label}</button>}
      />
    );

    expect(screen.getByRole('button', { name: 'pUC19' })).toBeInTheDocument();
    expect(container.textContent).not.toContain('[[ref:');
  });
});

describe('FormattedMessage — standard assistant markdown parity ', () => {
  it('preserves a single source newline as a hard line break', () => {
    const { container } = render(<FormattedMessage content={'Primer F: ATGC\nPrimer R: TTAC'} />);

    expect(container.querySelectorAll('br')).toHaveLength(1);
    expect(container.textContent).toContain('Primer F: ATGC');
    expect(container.textContent).toContain('Primer R: TTAC');
  });

  it('uses GFM with single-tilde strikethrough disabled', () => {
    const { container } = render(<FormattedMessage content="Anneal at ~55~65 °C" />);

    expect(container.querySelector('del')).toBeNull();
    expect(container.textContent).toContain('~55~65 °C');
  });

  it('renders standard emphasis while preserving intraword underscores', () => {
    const { container } = render(<FormattedMessage content="_lacZ_ and lacZ_1" />);

    expect(container.querySelector('em')).toHaveTextContent('lacZ');
    expect(container.textContent).toContain('lacZ_1');
  });

  it('renders raw HTML as inert visible text', () => {
    const { container } = render(<FormattedMessage content="<script>alert(1)</script>" />);

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('neutralizes javascript links and blocks relative and fragment navigation', () => {
    const { container } = render(
      <FormattedMessage
        content={
          '[unsafe](javascript:alert(1)) [relative](../reload) [fragment](#details) [safe](https://example.com)'
        }
      />
    );

    expect(screen.getByText('unsafe').closest('a')).toBeNull();
    expect(screen.getByText('relative').closest('a')).toBeNull();
    expect(screen.getByText('fragment').closest('a')).toBeNull();
    const safe = screen.getByRole('link', { name: 'safe' });
    expect(safe).toHaveAttribute('href', 'https://example.com/');
    expect(safe).toHaveAttribute('target', '_blank');
    expect(container.querySelectorAll('a')).toHaveLength(1);
  });

  it('pins the accepted lossy frontier behavior for FASTA-like headers', () => {
    const { container } = render(<FormattedMessage content=">seq1 pUC19 backbone" />);

    expect(container.querySelector('blockquote')).toHaveTextContent('seq1 pUC19 backbone');
    expect(container.textContent).not.toContain('>');
  });

  it('pins the accepted lossy frontier behavior for leading hash text', () => {
    const { container } = render(<FormattedMessage content="# of colonies" />);

    expect(container.querySelector('h1')).toHaveTextContent('of colonies');
    expect(container.textContent).not.toContain('#');
  });

  it('pins the accepted lossy frontier behavior for scientific asterisks', () => {
    const { container } = render(<FormattedMessage content="10*20 and 30*40" />);

    expect(container.querySelectorAll('em')).toHaveLength(1);
    expect(container.textContent).toBe('1020 and 3040');
  });

  it('keeps user-authored text literal instead of applying markdown', () => {
    const { container } = render(
      <FormattedMessage role="user" content={'**literal**\n>seq1\n# colonies'} />
    );

    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('blockquote')).toBeNull();
    expect(container.querySelector('h1')).toBeNull();
    expect(container.textContent).toContain('**literal**');
    expect(container.textContent).toContain('>seq1');
    expect(container.textContent).toContain('# colonies');
  });
});

describe('FormattedMessage — GFM tables ', () => {
  const TABLE = [
    '| Left | Center | Right |',
    '| :--- | :---: | ---: |',
    '| alpha | **bold** and `code` | escaped \\| pipe |',
  ].join('\n');

  it('renders a semantic table with alignment and inline formatting', () => {
    const { container } = render(<FormattedMessage content={TABLE} />);
    const table = container.querySelector('table');

    expect(table).not.toBeNull();
    const headers = within(table as HTMLElement).getAllByRole('columnheader');
    expect(headers).toHaveLength(3);
    expect(headers[0]).toHaveStyle({ textAlign: 'left' });
    expect(headers[1]).toHaveStyle({ textAlign: 'center' });
    expect(headers[2]).toHaveStyle({ textAlign: 'right' });
    expect(within(table as HTMLElement).getByText('bold').tagName).toBe('STRONG');
    expect(within(table as HTMLElement).getByText('code').tagName).toBe('CODE');
    expect(table).toHaveTextContent('escaped | pipe');
  });

  it('keeps a header-only streaming fragment as text until the delimiter arrives', () => {
    const { container } = render(<FormattedMessage content="| Name | Tm |" />);

    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('| Name | Tm |');
  });

  it('keeps pipe-table text inside a fenced block as code', () => {
    const { container } = render(
      <FormattedMessage content={'```text\n| Name | Tm |\n| --- | --- |\n```'} />
    );

    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('pre code')).toHaveTextContent('| Name | Tm |');
  });

  it('strips reference tokens before parsing an adjacent table', () => {
    const references = new Map([[UUID_A, makeRef(UUID_A, 'Primer set')]]);
    const { container } = render(
      <FormattedMessage content={`${TABLE}\n\n[[ref:${UUID_A}]]`} references={references} />
    );

    expect(container.querySelector('table')).not.toBeNull();
    expect(screen.getByTestId(`ref-chip-${UUID_A}`)).toBeInTheDocument();
    expect(container.textContent).not.toContain('[[ref:');
  });

  it('floats the original-markdown copy action below the bordered table frame', async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: clipboardWrite } });
    render(<FormattedMessage content={TABLE} />);

    const tableSurface = screen.getByTestId('markdown-table');
    const tableFrame = screen.getByTestId('markdown-table-frame');
    const wrapper = screen.getByTestId('markdown-table-scroll');
    const actions = screen.getByTestId('markdown-table-actions');
    const copyButton = within(actions).getByTitle('Copy');

    expect(wrapper.className).toContain('overflow-x-auto');
    expect(tableFrame.className).toContain('border');
    expect(tableFrame).toContainElement(wrapper);
    expect(tableFrame).not.toContainElement(copyButton);
    expect(actions.className).not.toMatch(/\bborder(?:-\S+)?\b|\bbg-\S+/);
    expect(tableSurface.children[0]).toBe(tableFrame);
    expect(tableSurface.children[1]).toBe(actions);
    await act(async () => {
      fireEvent.click(copyButton);
    });
    expect(clipboardWrite).toHaveBeenCalledWith(TABLE);
  });

  it('styles every HTML tag emitted by CommonMark and GFM', () => {
    const markdown = [
      '# H1',
      '## H2',
      '### H3',
      '#### H4',
      '##### H5',
      '###### H6',
      '',
      'Paragraph with **strong**, _emphasis_, ~~deleted~~, [link](https://example.com), and ![image](https://example.com/a.png).',
      '',
      'Line one',
      'Line two',
      '',
      '> Quote',
      '',
      '- unordered',
      '',
      '1. ordered',
      '',
      '- [x] task',
      '',
      '---',
      '',
      '`inline`',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      TABLE,
    ].join('\n');
    const { container } = render(<FormattedMessage content={markdown} />);
    const emittedTags = [
      'a',
      'blockquote',
      'br',
      'code',
      'del',
      'em',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'hr',
      'img',
      'input',
      'li',
      'ol',
      'p',
      'pre',
      'strong',
      'table',
      'tbody',
      'td',
      'th',
      'thead',
      'tr',
      'ul',
    ];

    for (const tag of emittedTags) {
      const element = container.querySelector(tag);
      expect(element, `${tag} should be emitted`).not.toBeNull();
      expect(element?.className, `${tag} should have explicit styling`).not.toBe('');
    }
  });
});
