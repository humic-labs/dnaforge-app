// @vitest-environment node

import { describe, it, expect } from 'vitest';
import MarkdownIt from 'markdown-it';
import {
  readMentionReference,
  markdownLinkDestination,
  markdownLabel,
  type NotebookReference,
} from './notebook-reference';

const md = new MarkdownIt();

function hrefOf(line: string): string | null {
  const tokens = md.parseInline(line, {});
  for (const t of tokens) {
    for (const child of t.children ?? []) {
      if (child.type === 'link_open') {
        const href = child.attrGet('href');
        return href === null ? null : decodeURIComponent(href);
      }
    }
  }
  return null;
}

describe('readMentionReference', () => {
  it('reads the new record shape', () => {
    const shape = readMentionReference({
      entityType: 'sequence',
      label: 'pUC19',
      path: 'sequences/vectors/pUC19.gb',
      entityId: null,
      contentHash: 'sha256:abc123',
    });
    expect(shape).toEqual({
      kind: 'record',
      ref: {
        path: 'sequences/vectors/pUC19.gb',
        entityId: null,
        contentHash: 'sha256:abc123',
      } satisfies NotebookReference,
    });
  });

  it('reads the SHIPPED MoClo legacy shape — a workspace-relative path in entityId, no path attr', () => {
    const shape = readMentionReference({
      id: 'sequences/kits/moclo-cidar/E1010m_CD.gb',
      label: 'E1010m (mRFP)',
      entityType: 'sequence',
      entityId: 'sequences/kits/moclo-cidar/E1010m_CD.gb',
    });
    expect(shape).toEqual({
      kind: 'legacy-path',
      path: 'sequences/kits/moclo-cidar/E1010m_CD.gb',
    });
  });

  it('reads the legacy sequence-row shape minted by @-search and the old picker', () => {
    expect(
      readMentionReference({ entityType: 'sequence', label: 'pUC19', entityId: 'seq_42' })
    ).toEqual({ kind: 'legacy-sequence-row', dbId: 42 });
  });

  it('reads a primer_<id> entityId as a primer row, not a path', () => {
    expect(
      readMentionReference({ entityType: 'primer', label: 'oJD-114', entityId: 'primer_7' })
    ).toEqual({ kind: 'legacy-primer-row', primerId: '7' });
  });

  it('is unresolvable when there is nothing to go on', () => {
    expect(readMentionReference({ entityType: 'sequence', label: 'x' }).kind).toBe('unresolvable');
    expect(readMentionReference({ entityType: 'page', entityId: 'page-1' }).kind).toBe(
      'unresolvable'
    );
  });

  it('prefers the record shape when BOTH a path attr and a legacy entityId are present', () => {
    const shape = readMentionReference({
      entityType: 'sequence',
      label: 'pUC19',
      entityId: 'sequences/vectors/pUC19.gb',
      path: 'sequences/vectors/pUC19.gb',
      contentHash: null,
    });
    expect(shape.kind).toBe('record');
  });
});

describe('markdownLinkDestination — relative depth', () => {
  const WS = '/Users/x/ws';

  it('computes depth for a notebook at the workspace root', () => {
    expect(markdownLinkDestination('sequences/pUC19.gb', WS, `${WS}/Lab notes`)).toBe(
      '<../sequences/pUC19.gb>'
    );
  });

  it('computes depth for a notebook one level down', () => {
    expect(markdownLinkDestination('sequences/pUC19.gb', WS, `${WS}/notebooks/Lab notes`)).toBe(
      '<../../sequences/pUC19.gb>'
    );
  });

  it('computes depth for a deeply nested notebook', () => {
    expect(markdownLinkDestination('sequences/pUC19.gb', WS, `${WS}/a/b/c/Lab notes`)).toBe(
      '<../../../../sequences/pUC19.gb>'
    );
  });

  it('normalizes Windows separators in the roots', () => {
    expect(
      markdownLinkDestination('sequences/pUC19.gb', 'C:\\ws', 'C:\\ws\\notebooks\\Lab notes')
    ).toBe('<../../sequences/pUC19.gb>');
  });
});

describe('markdownLinkDestination — encoding', () => {
  const WS = '/ws';
  const PKG = `${WS}/notebooks/Lab notes`;

  const CASES: Array<{ name: string; path: string }> = [
    { name: 'a space (SHIPPED: ecoli-nanobody)', path: 'sequences/kits/CD_NbLag2 (eGFP).gb' },
    { name: 'a trailing space before the extension', path: 'sequences/kits/T1T3_NT7pd .gb' },
    { name: 'a hash', path: 'sequences/a#b.gb' },
    { name: 'a question mark', path: 'sequences/a?b.gb' },
    { name: 'a percent', path: 'sequences/100%.gb' },
    { name: 'an angle bracket', path: 'sequences/a>b.gb' },
    { name: 'an opening angle bracket', path: 'sequences/a<b.gb' },
    { name: 'non-ASCII (em dash)', path: 'sequences/MoClo — red.gb' },
    { name: 'unbalanced parenthesis', path: 'sequences/a(b.gb' },
  ];

  for (const { name, path } of CASES) {
    it(`round-trips a path containing ${name}`, () => {
      const dest = markdownLinkDestination(path, WS, PKG);
      const line = `see [label](${dest}) here`;
      const href = hrefOf(line);
      expect(href, `no link parsed from: ${line}`).not.toBeNull();
      expect(href).toBe(`../../${path}`);
    });

    it(`emits no query or fragment for a path containing ${name}`, () => {
      const dest = markdownLinkDestination(path, WS, PKG);
      const raw = md
        .parseInline(`see [label](${dest}) here`, {})[0]
        .children?.find((c) => c.type === 'link_open');
      const href = raw?.attrGet('href') ?? '';
      expect(href.includes('#')).toBe(false);
      expect(href.includes('?')).toBe(false);
    });
  }

  it('leaves a clean path readable — no gratuitous encoding', () => {
    expect(markdownLinkDestination('sequences/vectors/pUC19.gb', WS, PKG)).toBe(
      '<../../sequences/vectors/pUC19.gb>'
    );
  });

  it('never emits a literal angle bracket inside the wrapper', () => {
    const dest = markdownLinkDestination('sequences/a>b.gb', WS, PKG);
    expect(dest.slice(1, -1)).not.toMatch(/[<>]/);
  });
});

describe('markdownLabel', () => {
  it('escapes brackets and backslashes', () => {
    expect(markdownLabel('pUC19 [v2]')).toBe('pUC19 \\[v2\\]');
    expect(markdownLabel('a\\b')).toBe('a\\\\b');
  });

  it('leaves parentheses alone — they are legal inside a label', () => {
    expect(markdownLabel('E1010m (mRFP)')).toBe('E1010m (mRFP)');
  });

  it('produces a label that survives markdown-it with the text intact', () => {
    const line = `see [${markdownLabel('pUC19 [v2]')}](<./x.gb>)`;
    const tokens = md.parseInline(line, {})[0].children ?? [];
    const text = tokens
      .filter((t) => t.type === 'text')
      .map((t) => t.content)
      .join('');
    expect(text).toContain('pUC19 [v2]');
  });
});
