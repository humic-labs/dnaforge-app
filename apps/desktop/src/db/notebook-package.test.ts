// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  buildNotebookPackageMetadata,
  buildNotebookPackageDocument,
  isNotebookPackageMemberRelativePath,
  isNotebookPackageMetaPath,
  notebookPackageRootForMetaPath,
  notebookPackagePaths,
  parseNotebookPackageDocument,
  parseNotebookPackageMetadata,
  NOTEBOOK_PACKAGE_FORMAT_VERSION,
  tipTapContentToMarkdown,
} from './notebook-package';

describe('notebook-package', () => {
  it('writes v2 metadata without TipTap or database authority fields', () => {
    const metadata = buildNotebookPackageMetadata({
      id: 'workspace::portable-id',
      title: 'Authority',
      markdownFileName: 'Authority.md',
      existing: { content: { type: 'doc' }, storage: { type: 'database' }, custom: 'kept' },
    });
    expect(metadata).toMatchObject({
      formatVersion: NOTEBOOK_PACKAGE_FORMAT_VERSION,
      id: 'portable-id',
      authority: { type: 'markdown', path: 'Authority.md' },
      custom: 'kept',
    });
    expect(metadata).not.toHaveProperty('content');
    expect(metadata).not.toHaveProperty('storage');
    expect(parseNotebookPackageMetadata(JSON.stringify(metadata))).toEqual(metadata);
  });

  it('fails closed on unknown future package versions', () => {
    const metadata = buildNotebookPackageMetadata({
      id: 'portable-id',
      title: 'Future',
      markdownFileName: 'Future.md',
    });
    expect(() =>
      parseNotebookPackageMetadata(JSON.stringify({ ...metadata, formatVersion: 99 }))
    ).toThrowError(expect.objectContaining({ code: 'NOTEBOOK_PACKAGE_NEWER_FORMAT' }));
  });

  it('fails closed on an unknown rich-block payload schema', () => {
    const metadata = buildNotebookPackageMetadata({
      id: 'portable-id',
      title: 'Unknown payload schema',
      markdownFileName: 'Unknown payload schema.md',
    });
    expect(() =>
      parseNotebookPackageMetadata(
        JSON.stringify({
          ...metadata,
          payloads: { ...metadata.payloads, schema: 'waypoint.notebook.block.v99' },
        })
      )
    ).toThrowError(expect.objectContaining({ code: 'NOTEBOOK_PACKAGE_INVALID' }));
  });

  it('builds package paths from a vault-shaped root', () => {
    expect(notebookPackagePaths('/lab/Lab notes')).toEqual({
      root: '/lab/Lab notes',
      markdownPath: '/lab/Lab notes/Lab notes.md',
      metaDir: '/lab/Lab notes/.forge',
      metaPath: '/lab/Lab notes/.forge/notebook.json',
      assetsDir: '/lab/Lab notes/assets',
      blocksDir: '/lab/Lab notes/.forge/blocks',
      migrationsDir: '/lab/Lab notes/.forge/migrations',
      migrationJournalPath: '/lab/Lab notes/.forge/notebook-migration.json',
      renameJournalPath: '/lab/Lab notes/.forge/notebook-rename.json',
    });
  });

  it('detects meta and member relative paths for sync allowlisting', () => {
    expect(isNotebookPackageMetaPath('/lab/Lab notes/.forge/notebook.json')).toBe(true);
    expect(isNotebookPackageMetaPath('/lab/Lab notes.md')).toBe(false);
    expect(notebookPackageRootForMetaPath('/lab/Lab notes/.forge/notebook.json')).toBe(
      '/lab/Lab notes'
    );
    expect(notebookPackageRootForMetaPath('/lab/Lab notes.md')).toBeNull();
    expect(isNotebookPackageMemberRelativePath('Lab notes/.forge/notebook.json')).toBe(true);
    expect(isNotebookPackageMemberRelativePath('Lab notes/Lab notes.md')).toBe(true);
    expect(isNotebookPackageMemberRelativePath('Lab notes/assets/fig.png')).toBe(true);
    expect(isNotebookPackageMemberRelativePath('readme.md')).toBe(false);
    expect(isNotebookPackageMemberRelativePath('other/notes.md')).toBe(false);
  });

  it('strips the workspace scope so the FILE carries the RAW embedded id (no repo_uuid leak)', () => {
    const scoped = buildNotebookPackageDocument({ id: 'repo-abc123::nb-uuid', title: 'T' });
    expect(scoped.id).toBe('nb-uuid');
    expect(scoped.storage.id).toBe('nb-uuid');
    const raw = buildNotebookPackageDocument({ id: 'nb-uuid', title: 'T' });
    expect(raw.id).toBe('nb-uuid');
  });

  it('round-trips package document JSON and projects readable markdown', () => {
    const doc = buildNotebookPackageDocument({
      id: 'page-1',
      title: 'Lab notes',
      content: {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Results' }],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Hello ', marks: [{ type: 'bold' }] },
              { type: 'text', text: 'world' },
              { type: 'text', text: ' underlined', marks: [{ type: 'underline' }] },
            ],
          },
        ],
      },
      updatedAt: '2026-07-10T00:00:00.000Z',
    });

    const parsed = parseNotebookPackageDocument(`${JSON.stringify(doc, null, 2)}\n`);
    expect(parsed).toMatchObject({
      schema: 'waypoint.notebook.v1',
      kind: 'notebook',
      id: 'page-1',
      title: 'Lab notes',
    });

    const md = tipTapContentToMarkdown(doc.content, doc.title);
    expect(md).toContain('# Lab notes');
    expect(md).toContain('## Results');
    expect(md).toContain('**Hello **world');
    expect(md).toContain('<u> underlined</u>');
  });

  it.each([
    [undefined, '1970-01-01T00:00:00.000Z'],
    ['not-a-timestamp', '1970-01-01T00:00:00.000Z'],
    ['2026-08-25T19:42:17.456', '2026-08-25T19:42:17.456Z'],
    ['2026-08-25T19:42:17.456+05:00', '2026-08-25T14:42:17.456Z'],
  ])('normalizes legacy timestamp %s to %s without host-local time', (updatedAt, expected) => {
    const legacy: Record<string, unknown> = {
      schema: 'waypoint.notebook.v1',
      kind: 'notebook',
      id: 'page-legacy-no-time',
      title: 'Legacy',
      content: { type: 'doc', content: [] },
    };
    if (updatedAt !== undefined) legacy.updatedAt = updatedAt;
    const serialized = JSON.stringify(legacy);

    expect(parseNotebookPackageDocument(serialized).updatedAt).toBe(expected);
    expect(parseNotebookPackageDocument(serialized).updatedAt).toBe(expected);
  });

  it('indents nested lists to the parent marker content column', () => {
    const paragraph = (text: string) => ({
      type: 'paragraph',
      content: [{ type: 'text', text }],
    });
    const nestedBullet = (text: string) => ({
      type: 'bulletList',
      content: [{ type: 'listItem', content: [paragraph(text)] }],
    });
    const content = {
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 9 },
          content: [
            { type: 'listItem', content: [paragraph('Ninth'), nestedBullet('under 9')] },
            { type: 'listItem', content: [paragraph('Tenth'), nestedBullet('under 10')] },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [paragraph('Done'), nestedBullet('under task')],
            },
          ],
        },
      ],
    };

    const md = tipTapContentToMarkdown(content);
    expect(md).toContain('9. Ninth\n\n   - under 9');
    expect(md).toContain('10. Tenth\n\n    - under 10');
    expect(md).toContain('- [x] Done\n\n      - under task');
  });

  it('strips an inherited :: scope on parse and never silently rewrites a multi-segment id to the last segment alone on a round-trip that re-scopes', () => {
    const leaked = {
      schema: 'waypoint.notebook.v1',
      kind: 'notebook',
      id: 'repo-a::nb-uuid',
      title: 'Leaked',
      content: { type: 'doc', content: [] },
      updatedAt: '2026-07-16T00:00:00.000Z',
    };
    const parsed = parseNotebookPackageDocument(`${JSON.stringify(leaked, null, 2)}\n`);
    expect(parsed.id).toBe('nb-uuid');
    expect(parsed.storage.id).toBe('nb-uuid');

    const rebuilt = buildNotebookPackageDocument({
      id: parsed.id,
      title: parsed.title,
      content: parsed.content,
    });
    expect(rebuilt.id).toBe('nb-uuid');
    expect(buildNotebookPackageDocument({ id: 'a::b', title: 'X' }).id).toBe('b');
    const reScoped = buildNotebookPackageDocument({
      id: 'repo-b::nb-uuid',
      title: 'X',
    });
    expect(reScoped.id).toBe('nb-uuid');
  });
});
