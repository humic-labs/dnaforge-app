import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseWorkspaceSyncManifest,
  workspaceSyncManifestHashInput,
  workspaceSyncManifestRequestHashInput,
} from './workspace-sync-manifest';

function file(
  path: string,
  contentSha256: string,
  sizeBytes: number,
  contentType = 'application/octet-stream'
) {
  return { path, contentSha256, sizeBytes, contentType };
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('workspace sync manifest contract', () => {
  it('admits a 50 GiB project with 5 GiB files using metadata only', () => {
    const files = Array.from({ length: 10 }, (_, index) =>
      file(`design-${index}.gb`, 'a'.repeat(64), 5 * 1024 ** 3)
    );
    const parsed = parseWorkspaceSyncManifest({ schemaVersion: 1, files });
    expect(parsed.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ schemaVersion: 1, files }))).toBeLessThan(4096);
  });

  it('rejects a project larger than 50 GiB even when each file is admitted', () => {
    const files = Array.from({ length: 11 }, (_, index) =>
      file(`design-${index}.gb`, 'a'.repeat(64), 5 * 1024 ** 3)
    );
    expect(
      parseWorkspaceSyncManifest(
        { schemaVersion: 1, files },
        { maxFileBytes: 5 * 1024 ** 3, maxProjectBytes: 50 * 1024 ** 3, maxFiles: 2000 }
      )
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('project limit')]),
    });
  });
  it('parses and deterministically sorts an unordered manifest', () => {
    const parsed = parseWorkspaceSyncManifest({
      schemaVersion: 1,
      files: [
        file('notes/experiment.md', 'b'.repeat(64), 31, 'text/markdown'),
        file('designs/vector.gb', 'a'.repeat(64), 4096, 'application/genbank'),
      ],
    });

    expect(parsed).toEqual({
      ok: true,
      manifest: {
        schemaVersion: 1,
        files: [
          file('designs/vector.gb', 'a'.repeat(64), 4096, 'application/genbank'),
          file('notes/experiment.md', 'b'.repeat(64), 31, 'text/markdown'),
        ],
      },
    });
  });

  it('produces the same manifest hash for every input order', () => {
    const first = parseWorkspaceSyncManifest({
      schemaVersion: 1,
      files: [
        file('b.txt', 'b'.repeat(64), 2, 'text/plain'),
        file('a.txt', 'a'.repeat(64), 1, 'text/plain'),
      ],
    });
    const second = parseWorkspaceSyncManifest({
      schemaVersion: 1,
      files: [
        file('a.txt', 'a'.repeat(64), 1, 'text/plain'),
        file('b.txt', 'b'.repeat(64), 2, 'text/plain'),
      ],
    });
    if (!first.ok || !second.ok) throw new Error('fixture must be valid');

    expect(digest(workspaceSyncManifestHashInput(first.manifest))).toBe(
      digest(workspaceSyncManifestHashInput(second.manifest))
    );
    expect(workspaceSyncManifestHashInput(first.manifest)).toContain(
      'dnaforge.workspace-sync-manifest/v1'
    );
  });

  it('uses PostgreSQL C-collation byte order for non-ASCII paths', () => {
    const parsed = parseWorkspaceSyncManifest({
      schemaVersion: 1,
      files: [
        file('\u{1f600}.txt', 'b'.repeat(64), 2, 'text/plain'),
        file('\ue000.txt', 'a'.repeat(64), 1, 'text/plain'),
      ],
    });
    if (!parsed.ok) throw new Error('fixture must be valid');

    expect(parsed.manifest.files.map((entry) => entry.path)).toEqual([
      '\ue000.txt',
      '\u{1f600}.txt',
    ]);
    expect(digest(workspaceSyncManifestHashInput(parsed.manifest))).toBe(
      '88621057c1446a4cc20c92164062f8979a1a9f6051b0bfc2f39eedf0ca2383ce'
    );
  });

  it('binds the idempotency request hash to the base version', () => {
    const parsed = parseWorkspaceSyncManifest({
      schemaVersion: 1,
      files: [file('design.gb', 'a'.repeat(64), 12, 'application/genbank')],
    });
    if (!parsed.ok) throw new Error('fixture must be valid');

    const withoutBase = digest(workspaceSyncManifestRequestHashInput(null, parsed.manifest));
    const withBase = digest(
      workspaceSyncManifestRequestHashInput('11111111-1111-4111-8111-111111111111', parsed.manifest)
    );

    expect(withBase).not.toBe(withoutBase);
  });

  it.each([
    {
      label: 'unknown top-level key',
      value: { schemaVersion: 1, files: [], extra: true },
      error: 'manifest contains unsupported fields',
    },
    {
      label: 'unknown file key',
      value: {
        schemaVersion: 1,
        files: [{ ...file('a.txt', 'a'.repeat(64), 1, 'text/plain'), storagePath: 'secret' }],
      },
      error: 'files[0] contains unsupported fields',
    },
    {
      label: 'unsafe parent path',
      value: { schemaVersion: 1, files: [file('../a.txt', 'a'.repeat(64), 1)] },
      error: 'files[0].path is unsafe',
    },
    {
      label: 'backslash path',
      value: { schemaVersion: 1, files: [file('folder\\a.txt', 'a'.repeat(64), 1)] },
      error: 'files[0].path is unsafe',
    },
    {
      label: 'path control character',
      value: { schemaVersion: 1, files: [file('folder/a\n.txt', 'a'.repeat(64), 1)] },
      error: 'files[0].path is unsafe',
    },
    {
      label: 'uppercase digest',
      value: { schemaVersion: 1, files: [file('a.txt', 'A'.repeat(64), 1)] },
      error: 'files[0].contentSha256 must be a lowercase SHA-256 digest',
    },
    {
      label: 'unsafe byte count',
      value: { schemaVersion: 1, files: [file('a.txt', 'a'.repeat(64), Number.MAX_VALUE)] },
      error: 'files[0].sizeBytes must be a safe non-negative integer',
    },
    {
      label: 'blank content type',
      value: { schemaVersion: 1, files: [file('a.txt', 'a'.repeat(64), 1, ' ')] },
      error: 'files[0].contentType is invalid',
    },
  ])('rejects $label', ({ value, error }) => {
    const parsed = parseWorkspaceSyncManifest(value);
    expect(parsed).toEqual({ ok: false, errors: expect.arrayContaining([error]) });
  });

  it('rejects duplicate and case-colliding paths', () => {
    const duplicate = parseWorkspaceSyncManifest({
      schemaVersion: 1,
      files: [file('a.txt', 'a'.repeat(64), 1), file('a.txt', 'b'.repeat(64), 2)],
    });
    const caseCollision = parseWorkspaceSyncManifest({
      schemaVersion: 1,
      files: [file('Folder/A.txt', 'a'.repeat(64), 1), file('folder/a.txt', 'b'.repeat(64), 2)],
    });

    expect(duplicate).toEqual({
      ok: false,
      errors: expect.arrayContaining(['files[1].path is duplicated']),
    });
    expect(caseCollision).toEqual({
      ok: false,
      errors: expect.arrayContaining(['files[1].path collides case-insensitively']),
    });
  });

  it('accepts an empty workspace and rejects more than 2,000 files', () => {
    expect(parseWorkspaceSyncManifest({ schemaVersion: 1, files: [] })).toEqual({
      ok: true,
      manifest: { schemaVersion: 1, files: [] },
    });

    const files = Array.from({ length: 2001 }, (_, index) =>
      file(`files/${index}.txt`, 'a'.repeat(64), index, 'text/plain')
    );
    expect(parseWorkspaceSyncManifest({ schemaVersion: 1, files })).toEqual({
      ok: false,
      errors: ['files must contain at most 2000 entries'],
    });
  });
});
