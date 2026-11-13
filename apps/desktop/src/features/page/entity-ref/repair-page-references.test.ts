import { describe, expect, it, vi } from 'vitest';

import { repairPageReferences } from './repair-page-references';

const findMock = vi.fn();

vi.mock('../../../db/find-current-files-by-filename', () => ({
  findCurrentFilesByFilename: (...args: unknown[]) => findMock(...args),
}));

const findNotebookMock = vi.fn(async () => []);

vi.mock('../../../db/find-notebook-file-by-page-id', () => ({
  findNotebookFileByPageId: (...args: unknown[]) => findNotebookMock(...args),
}));

const ROOT = '/ws/alpha';

function legacyMention(entityId: string, label: string) {
  return { type: 'mention', attrs: { entityType: 'sequence', entityId, label } };
}

function doc(...mentions: unknown[]) {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Cloning log' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'We cut ' }, ...mentions] },
    ],
  };
}

function mentionsOf(content: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const node = n as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
    if (node.type === 'mention' && node.attrs) out.push(node.attrs);
    if (node.content) walk(node.content);
  };
  walk((content as { content?: unknown }).content);
  return out;
}

describe('repairPageReferences', () => {
  it('writes the record into a legacy chip', async () => {
    findMock.mockResolvedValue([
      {
        path: 'sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb',
        contentHash: 'git:25f23973',
        objectUuid: '2b44d82f-102d-45ee-b99d-a17ea9c0c09d',
        entityId: 'fe1c174a',
      },
    ]);

    const input = doc(legacyMention('sequences/kits/moclo-cidar/E1010m_CD.gb', 'E1010m (mRFP)'));
    const result = await repairPageReferences(input, ROOT);

    expect(result.repaired).toBe(1);
    const [attrs] = mentionsOf(result.content);
    expect(attrs.path).toBe('sequences/kits/moclo-cidar/E1010m_CD/E1010m_CD.gb');
    expect(attrs.objectUuid).toBe('2b44d82f-102d-45ee-b99d-a17ea9c0c09d');
    expect(attrs.contentHash).toBeNull();
    expect(attrs.label).toBe('E1010m (mRFP)');
  });

  it('🟥 does NOT mutate the caller document', async () => {
    findMock.mockResolvedValue([
      { path: 'a/b.gb', contentHash: null, objectUuid: 'u1', entityId: 'e1' },
    ]);

    const input = doc(legacyMention('a.gb', 'A'));
    const before = JSON.stringify(input);
    await repairPageReferences(input, ROOT);

    expect(JSON.stringify(input)).toBe(before);
  });

  it('🟥 looks up each DISTINCT file once, not once per chip', async () => {
    findMock.mockClear();
    findMock.mockResolvedValue([
      { path: 'a/x.gb', contentHash: null, objectUuid: 'u1', entityId: 'e1' },
    ]);

    const input = doc(
      legacyMention('x.gb', 'X'),
      legacyMention('x.gb', 'X'),
      legacyMention('x.gb', 'X')
    );
    const result = await repairPageReferences(input, ROOT);

    expect(result.repaired).toBe(3);
    expect(findMock).toHaveBeenCalledTimes(1);
  });

  it('leaves an ambiguous chip untouched and reports it', async () => {
    findMock.mockResolvedValue([
      { path: 'kits/pUC19.gb', contentHash: null, objectUuid: 'ua', entityId: 'ea' },
      { path: 'backup/pUC19.gb', contentHash: null, objectUuid: 'ub', entityId: 'eb' },
    ]);

    const input = doc(legacyMention('pUC19.gb', 'pUC19'));
    const result = await repairPageReferences(input, ROOT);

    expect(result.repaired).toBe(0);
    expect(result.skipped).toEqual([{ label: 'pUC19', reason: 'ambiguous' }]);
    expect(mentionsOf(result.content)[0].path).toBeUndefined();
  });

  it('reports no change when there is nothing to repair', async () => {
    findMock.mockClear();
    findMock.mockResolvedValue([]);
    const input = doc();
    const result = await repairPageReferences(input, ROOT);

    expect(result).toEqual({ content: input, repaired: 0, skipped: [], changed: false });
    expect(findMock).not.toHaveBeenCalled();
  });

  it('is idempotent — a second pass repairs nothing', async () => {
    findMock.mockResolvedValue([
      { path: 'a/b.gb', contentHash: null, objectUuid: 'u1', entityId: 'e1' },
    ]);

    const first = await repairPageReferences(doc(legacyMention('a.gb', 'A')), ROOT);
    expect(first.repaired).toBe(1);

    const second = await repairPageReferences(first.content, ROOT);
    expect(second.repaired).toBe(0);
    expect(second.changed).toBe(false);
  });

  it('skips everything when there is no owning root', async () => {
    findMock.mockClear();
    findMock.mockResolvedValue([]);
    const input = doc(legacyMention('a.gb', 'A'));
    const result = await repairPageReferences(input, null);

    expect(result.changed).toBe(false);
    expect(findMock).not.toHaveBeenCalled();
  });

  it('survives a lookup failure without touching the document', async () => {
    findMock.mockImplementation(() => {
      throw new Error('db gone');
    });

    const input = doc(legacyMention('a.gb', 'A'));
    const result = await repairPageReferences(input, ROOT);

    expect(result.changed).toBe(false);
    expect(result.repaired).toBe(0);

    expect(result.skipped).toEqual([]);
    expect(result.content).toBe(input);
  });

  it('preserves unrelated document structure exactly', async () => {
    findMock.mockResolvedValue([
      { path: 'a/b.gb', contentHash: null, objectUuid: 'u1', entityId: 'e1' },
    ]);

    const input = doc(legacyMention('a.gb', 'A'));
    const result = await repairPageReferences(input, ROOT);

    const heading = (result.content as { content: { type: string }[] }).content[0];
    expect(heading).toEqual({
      type: 'heading',
      attrs: { level: 1 },
      content: [{ type: 'text', text: 'Cloning log' }],
    });
  });

  it('repairs a mention nested deep inside a list', async () => {
    findMock.mockResolvedValue([
      { path: 'a/b.gb', contentHash: null, objectUuid: 'u1', entityId: 'e1' },
    ]);

    const nested = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [legacyMention('a.gb', 'A')] }],
            },
          ],
        },
      ],
    };

    const result = await repairPageReferences(nested, ROOT);
    expect(result.repaired).toBe(1);
    expect(mentionsOf(result.content)[0].objectUuid).toBe('u1');
  });
});

describe('references to OTHER NOTEBOOK ENTRIES get a destination', () => {
  const pageMention = (id: string, label: string) => ({
    type: 'mention',
    attrs: { entityType: 'page', entityId: id, label, path: null },
  });

  it('back-fills the path so the link survives outside the app', async () => {
    findMock.mockReset();
    findNotebookMock.mockReset();
    findNotebookMock.mockResolvedValue([{ path: 'notebooks/11 — Burden mitigation' }]);

    const result = await repairPageReferences(
      doc(pageMention('corpus-11-burden-mitigation', '11 — Burden mitigation')),
      ROOT
    );

    expect(result.changed).toBe(true);
    expect(mentionsOf(result.content)[0].path).toBe('notebooks/11 — Burden mitigation');
  });

  it('repairs an UNLABELLED entry link, which no sequence key covers', async () => {
    findMock.mockReset();
    findMock.mockResolvedValue([]);
    findNotebookMock.mockReset();
    findNotebookMock.mockResolvedValue([{ path: 'notebooks/18 — Synthesis' }]);

    const result = await repairPageReferences(
      doc({
        type: 'mention',
        attrs: { entityType: 'page', entityId: 'corpus-18-synthesis', label: '', path: null },
      }),
      ROOT
    );

    expect(findNotebookMock).toHaveBeenCalled();
    expect(result.repaired).toBe(1);
  });

  it('leaves entityId portable', async () => {
    findMock.mockReset();
    findNotebookMock.mockReset();
    findNotebookMock.mockResolvedValue([{ path: 'notebooks/11' }]);

    const result = await repairPageReferences(
      doc(pageMention('corpus-11-burden-mitigation', '11')),
      ROOT
    );

    expect(mentionsOf(result.content)[0].entityId).toBe('corpus-11-burden-mitigation');
  });

  it('a failed notebook lookup does not cancel a good sequence repair', async () => {
    findMock.mockReset();
    findMock.mockResolvedValue([
      { path: 'sequences/E1010m_CD.gb', contentHash: 'sha256:a', objectUuid: 'u1', entityId: 'e1' },
    ]);
    findNotebookMock.mockReset();
    findNotebookMock.mockRejectedValue(new Error('db down'));

    const result = await repairPageReferences(
      doc(
        legacyMention('sequences/kits/E1010m_CD.gb', 'E1010m'),
        pageMention('corpus-11-burden-mitigation', '11')
      ),
      ROOT
    );

    expect(result.repaired).toBe(1);
    expect(mentionsOf(result.content)[0].path).toBe('sequences/E1010m_CD.gb');
  });
});
