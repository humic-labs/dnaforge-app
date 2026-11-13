import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  validateNewBundleFilePolicy,
  validateWorkspaceSyncBundle,
  workspaceSyncBundleHashInput,
} from './index';
import { workspaceSyncManifestHashInput } from './workspace-sync-manifest';

const file = {
  id: 'large-design',
  relativePath: 'library.gb',
  name: 'library.gb',
  kind: 'genbank',
  contentType: 'text/plain',
  sizeBytes: 5 * 1024 ** 3,
  sha256: 'a'.repeat(64),
  content: '',
  encoding: 'blob',
};
const bundle = {
  schemaVersion: 3,
  capturedAt: '2026-10-01T00:00:00.000Z',
  workspace: { id: 'workspace', name: 'Large library' },
  files: [file],
  excludedSummary: Object.fromEntries(
    [
      'unsupported',
      'private-raw-data',
      'reference-pointer',
      'file-too-large',
      'bundle-too-large',
    ].map((reason) => [reason, { count: 0, bytesApprox: 0 }])
  ),
  limits: { maxFileBytes: 5 * 1024 ** 3, maxBundleBytes: 50 * 1024 ** 3, maxFiles: 2000 },
  provenance: { source: 'dnaforge-desktop', appVersion: '1.0.0', contentSha256: 'b'.repeat(64) },
};

describe('blob-backed desktop snapshot contract', () => {
  it('accepts large files without embedding their bytes', () => {
    expect(validateWorkspaceSyncBundle(bundle).ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(bundle))).toBeLessThan(2048);
  });
  it('hashes exactly the same canonical manifest as the server', () => {
    const parsed = validateWorkspaceSyncBundle(bundle);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    const expected = workspaceSyncManifestHashInput({
      schemaVersion: 1,
      files: [
        {
          path: file.relativePath,
          contentSha256: file.sha256,
          sizeBytes: file.sizeBytes,
          contentType: file.contentType,
        },
      ],
    });
    expect(
      createHash('sha256').update(workspaceSyncBundleHashInput(parsed.bundle)).digest('hex')
    ).toBe(createHash('sha256').update(expected).digest('hex'));
  });
  it('rejects embedded content masquerading as a blob reference', () => {
    expect(
      validateWorkspaceSyncBundle({ ...bundle, files: [{ ...file, content: 'hidden bytes' }] }).ok
    ).toBe(false);
  });
  it('preserves the exclusion of private raw sequencing data', () => {
    expect(
      validateWorkspaceSyncBundle({ ...bundle, files: [{ ...file, relativePath: 'reads.fastq' }] })
        .ok
    ).toBe(false);
  });

  it.each([
    ['notes.txt', 'text/plain'],
    ['preview.png', 'image/png'],
  ])(
    'admits private ordinary %s only in schema3, without widening legacy/share policy',
    (path, contentType) => {
      const parsed = validateWorkspaceSyncBundle({
        ...bundle,
        files: [
          {
            ...file,
            relativePath: path,
            name: path,
            kind: 'workspace-resource',
            contentType,
            sizeBytes: 1,
          },
        ],
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.errors.join('; '));
      expect(validateNewBundleFilePolicy(parsed.bundle).ok).toBe(true);
      expect(validateNewBundleFilePolicy({ ...parsed.bundle, schemaVersion: 2 }).ok).toBe(false);
      for (const schemaVersion of [1, 2]) {
        expect(validateWorkspaceSyncBundle({ ...parsed.bundle, schemaVersion }).ok).toBe(false);
      }
    }
  );
});
