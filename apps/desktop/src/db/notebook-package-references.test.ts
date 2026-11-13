// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { tipTapContentToMarkdown } from './notebook-package';

const ROOTS = {
  workspaceRoot: '/ws/beta',
  packageRoot: '/ws/beta/notes/Experiment 1.forge',
};

function doc(...inline: unknown[]) {
  return { type: 'doc', content: [{ type: 'paragraph', content: inline }] };
}

function mention(attrs: Record<string, unknown>) {
  return { type: 'mention', attrs };
}

function hrefIn(markdown: string): string {
  return markdown.match(/\]\(<([^>]*)>\)/)?.[1] ?? markdown.match(/\]\(([^)]*)\)/)?.[1] ?? '';
}

describe('markdown projection of references', () => {
  it('writes a chip as a CommonMark link to the referenced file', () => {
    const md = tipTapContentToMarkdown(
      doc(
        { type: 'text', text: 'we cut ' },
        mention({ label: 'pUC19', path: 'sequences/pUC19.gb', entityType: 'sequence' }),
        { type: 'text', text: ' with EcoRI' }
      ),
      undefined,
      ROOTS
    );

    expect(md).toContain('[pUC19](');
    expect(md).toContain('we cut ');
    expect(md).toContain(' with EcoRI');
  });

  it('resolves the link relative to the PACKAGE, not the workspace root', () => {
    const md = tipTapContentToMarkdown(
      doc(mention({ label: 'x', path: 'sequences/a.gb' })),
      undefined,
      ROOTS
    );

    expect(decodeURIComponent(hrefIn(md))).toContain('../../sequences/a.gb');
  });

  it('does not drop the reference when the chip has no path (D9 local-only)', () => {
    const md = tipTapContentToMarkdown(
      doc({ type: 'text', text: 'used ' }, mention({ label: 'hand-entered', path: null })),
      undefined,
      ROOTS
    );

    expect(md).toContain('hand-entered');
  });

  it('falls back to the label when no roots are supplied', () => {
    const md = tipTapContentToMarkdown(
      doc(mention({ label: 'pUC19', path: 'sequences/pUC19.gb' })),
      undefined
    );

    expect(md).toContain('pUC19');
  });

  it('escapes link-breaking characters in the label', () => {
    const md = tipTapContentToMarkdown(
      doc(mention({ label: 'clone [A]', path: 'sequences/a.gb' })),
      undefined,
      ROOTS
    );

    expect(md).toContain('\\[A\\]');
  });

  it('percent-encodes a path containing a space and a hash', () => {
    const md = tipTapContentToMarkdown(
      doc(mention({ label: 'x', path: 'kits/CD_NbLag2 (eGFP)#1.gb' })),
      undefined,
      ROOTS
    );

    const href = hrefIn(md);
    expect(href).not.toContain(' ');
    expect(href).not.toContain('#');
    expect(decodeURIComponent(href)).toContain('CD_NbLag2 (eGFP)#1.gb');
  });

  it('keeps surrounding formatting intact around a chip', () => {
    const md = tipTapContentToMarkdown(
      doc(
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        mention({ label: 'x', path: 'a.gb' })
      ),
      undefined,
      ROOTS
    );

    expect(md).toContain('**bold**');
  });

  it('links a LEGACY chip whose entityId IS the workspace path', () => {
    const md = tipTapContentToMarkdown(
      doc(
        mention({
          label: 'E1010m (mRFP)',
          entityId: 'sequences/kits/moclo-cidar/E1010m_CD.gb',
          entityType: 'sequence',
        })
      ),
      undefined,
      ROOTS
    );

    expect(md).toContain('[E1010m (mRFP)](');
    expect(decodeURIComponent(hrefIn(md))).toContain('E1010m_CD.gb');
  });

  it('does NOT invent a link from a non-path entityId', () => {
    const md = tipTapContentToMarkdown(
      doc(mention({ label: 'x', entityId: 'ent-1', entityType: 'sequence' })),
      undefined,
      ROOTS
    );

    expect(md).not.toContain('](');
    expect(md).toContain('x');
  });

  it('does not export an escaping notebook path as a clickable link', () => {
    const md = tipTapContentToMarkdown(
      doc(mention({ label: 'private', path: '../../outside.gb', entityType: 'sequence' })),
      undefined,
      ROOTS
    );

    expect(md).toContain('private');
    expect(md).not.toContain('](');
    expect(md).not.toContain('outside.gb');
  });

  it('prefers an explicit path over a legacy entityId when both exist', () => {
    const md = tipTapContentToMarkdown(
      doc(mention({ label: 'x', path: 'new/real.gb', entityId: 'old/stale.gb' })),
      undefined,
      ROOTS
    );

    expect(decodeURIComponent(hrefIn(md))).toContain('new/real.gb');
  });

  it('handles several chips in one paragraph', () => {
    const md = tipTapContentToMarkdown(
      doc(
        mention({ label: 'one', path: 'a.gb' }),
        { type: 'text', text: ' and ' },
        mention({ label: 'two', path: 'b.gb' })
      ),
      undefined,
      ROOTS
    );

    expect(md).toContain('[one](');
    expect(md).toContain('[two](');
    expect(md).toContain(' and ');
  });
});

describe('a link to another NOTEBOOK ENTRY must land on a file, not a folder', () => {
  it('points at the .md inside the package', () => {
    const md = tipTapContentToMarkdown(
      doc(
        mention({
          entityType: 'page',
          entityId: 'corpus-02-part-inventory',
          label: '02 — Part inventory',
          path: 'notebooks/02 — Part inventory',
        })
      ),
      undefined,
      ROOTS
    );
    expect(md).toContain('02%20%E2%80%94%20Part%20inventory.md>');
  });

  it('leaves a FILE-backed reference pointing straight at the file', () => {
    const md = tipTapContentToMarkdown(
      doc(
        mention({
          entityType: 'sequence',
          entityId: 'e1',
          label: 'pUC19',
          path: 'sequences/pUC19/pUC19.gb',
        })
      ),
      undefined,
      ROOTS
    );
    expect(md).toContain('pUC19.gb>');
    expect(md).not.toContain('.gb/');
  });
});
