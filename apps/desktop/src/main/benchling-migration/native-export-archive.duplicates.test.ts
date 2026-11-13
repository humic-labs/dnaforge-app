import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildSyntheticNativeExportZip } from './__fixtures__/native-export-zip-fixture';
import { validateArchiveEntries } from './content-archive';
import {
  DEFAULT_NATIVE_EXPORT_ARCHIVE_LIMITS,
  inspectNativeExportArchive,
  walkNativeExportArchive,
} from './native-export-archive';

describe('duplicate paths in a native export archive', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function source(entries: Parameters<typeof buildSyntheticNativeExportZip>[0]) {
    const root = await mkdtemp(join(tmpdir(), 'duplicate-path-'));
    roots.push(root);
    const fixture = buildSyntheticNativeExportZip(entries);
    const localPath = join(root, 'export.zip');
    await writeFile(localPath, Buffer.from(fixture.bytes));
    return {
      kind: 'local_path' as const,
      logicalFilename: 'export.zip',
      localPath,
      expectedSha256: fixture.sha256,
      expectedSizeBytes: fixture.sizeBytes,
      duplicateSupportEntryPolicy: 'identical_root_benchling_css' as const,
    };
  }

  it('allows the catalog size of an observed full Benchling folder export', () => {
    expect(DEFAULT_NATIVE_EXPORT_ARCHIVE_LIMITS.maxEntries).toBeGreaterThanOrEqual(39_380);
  });

  it('accepts a byte-identical duplicate that is not the root stylesheet', async () => {
    const asset = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>';
    const archive = await source([
      { path: 'Notebook A (etr_AAAAAA).html', bytes: '<html><body>A</body></html>' },
      { path: 'assets/benchling-html-asset-snapshot-seq_AAAAAA.svg', bytes: asset },
      { path: 'Notebook B (etr_BBBBBB).html', bytes: '<html><body>B</body></html>' },
      { path: 'assets/benchling-html-asset-snapshot-seq_AAAAAA.svg', bytes: asset },
    ]);

    const inspected = await inspectNativeExportArchive(archive);

    const assetEntries = inspected.entries.filter(
      (entry) => entry.path === 'assets/benchling-html-asset-snapshot-seq_AAAAAA.svg'
    );
    expect(assetEntries).toHaveLength(1);
  });

  it('discards conflicting Benchling sequence snapshot previews without weakening other paths', async () => {
    const snapshotPath = 'Registry/assets/benchling-html-asset-snapshot-seq_AAAAAA.svg';
    const archive = await source([
      { path: 'Registry/Notebook A (etr_AAAAAA).html', bytes: '<html>A</html>' },
      { path: snapshotPath, bytes: '<svg><text>preview A</text></svg>' },
      { path: 'Registry/Notebook B (etr_BBBBBB).html', bytes: '<html>B</html>' },
      { path: snapshotPath, bytes: '<svg><text>preview B</text></svg>' },
    ]);

    const inspected = await inspectNativeExportArchive(archive);

    expect(inspected.entries.filter((entry) => entry.path === snapshotPath)).toHaveLength(1);
  });

  it('keeps a nested ZIP filename inert when Benchling exported it as an attachment', async () => {
    const attachmentPath = 'Registry/Plasmid (seq_AAAAAA) sequencing-results.zip.zip';
    const archive = await source([
      {
        path: 'Registry/Plasmid (seq_AAAAAA).gb',
        bytes: 'LOCUS       PLASMID 4 bp DNA\nORIGIN\n        1 acgt\n//',
      },
      { path: attachmentPath, bytes: 'opaque attachment bytes; never recursively decoded' },
    ]);

    const inspected = await inspectNativeExportArchive(archive);

    expect(inspected.entries.some((entry) => entry.path === attachmentPath)).toBe(true);
  });

  it('keeps the generic archive validator fail-closed for nested archives', () => {
    expect(() =>
      validateArchiveEntries([
        { path: 'attachments/untrusted.zip', uncompressedBytes: 16, isDirectory: false },
      ])
    ).toThrow(/Nested archives are not supported/iu);
  });

  it('refuses a duplicate whose bytes differ', async () => {
    const archive = await source([
      { path: 'Notebook A (etr_AAAAAA).html', bytes: '<html><body>A</body></html>' },
      { path: 'assets/shadow.svg', bytes: '<svg>original</svg>' },
      { path: 'assets/shadow.svg', bytes: '<svg>REPLACED</svg>' },
    ]);

    await expect(inspectNativeExportArchive(archive)).rejects.toThrow(/duplicate path/iu);
  });

  it('refuses a duplicate whose bytes differ only in length', async () => {
    const archive = await source([
      { path: 'Notebook A (etr_AAAAAA).html', bytes: '<html><body>A</body></html>' },
      { path: 'assets/shadow.svg', bytes: '<svg>abc</svg>' },
      { path: 'assets/shadow.svg', bytes: '<svg>abcd</svg>' },
    ]);

    await expect(inspectNativeExportArchive(archive)).rejects.toThrow(/duplicate path/iu);
  });

  it('preserves distinct legacy GenBank records that share a display-name path', async () => {
    const archive = await source([
      {
        path: 'Duplicate display name.gb',
        bytes: 'LOCUS       first 4 bp DNA linear\nORIGIN\n        1 acgt\n//\n',
      },
      {
        path: 'Duplicate display name.gb',
        bytes: 'LOCUS       second 5 bp DNA linear\nORIGIN\n        1 acgta\n//\n',
      },
    ]);

    const inspected = await inspectNativeExportArchive(archive);
    const genBankEntries = inspected.entries.filter((entry) => entry.path.endsWith('.gb'));
    expect(genBankEntries).toHaveLength(2);
    expect(new Set(genBankEntries.map((entry) => entry.path))).toHaveLength(2);

    const walkedPaths: string[] = [];
    await walkNativeExportArchive(
      inspected,
      () => ({ kind: 'full', maxBytes: 1_024 }),
      (evidence) => {
        walkedPaths.push(evidence.path);
      }
    );
    expect(walkedPaths.sort()).toEqual(genBankEntries.map((entry) => entry.path).sort());
  });

  it('refuses conflicting GenBank copies that claim the same Benchling identity', async () => {
    const archive = await source([
      {
        path: 'Named sequence (seq_EXACT123).gb',
        bytes: 'LOCUS       first 4 bp DNA linear\nORIGIN\n        1 acgt\n//\n',
      },
      {
        path: 'Named sequence (seq_EXACT123).gb',
        bytes: 'LOCUS       second 5 bp DNA linear\nORIGIN\n        1 acgta\n//\n',
      },
    ]);

    await expect(inspectNativeExportArchive(archive)).rejects.toThrow(/duplicate path/iu);
  });

  it('refuses an oversized archive BEFORE decompressing its duplicates', async () => {
    const archive = await source([
      { path: 'Notebook A (etr_AAAAAA).html', bytes: '<html><body>oversized</body></html>' },
      { path: 'assets/shadow.svg', bytes: '<svg>original</svg>' },
      { path: 'assets/shadow.svg', bytes: '<svg>REPLACED</svg>' },
    ]);

    await expect(
      inspectNativeExportArchive(archive, { maxTotalUncompressedBytes: 8 })
    ).rejects.toThrow(/uncompressed bytes; limit is/iu);
  });

  it('still accepts the repeated root stylesheet it always did', async () => {
    const css = 'body { color: #111; }';
    const archive = await source([
      { path: 'benchling.css', bytes: css },
      { path: 'Notebook A (etr_AAAAAA).html', bytes: '<html><body>A</body></html>' },
      { path: 'benchling.css', bytes: css },
    ]);

    await expect(inspectNativeExportArchive(archive)).resolves.toBeTruthy();
  });

  it('refuses a repeated root stylesheet whose bytes differ', async () => {
    const archive = await source([
      { path: 'benchling.css', bytes: 'body { color: #111; }' },
      { path: 'Notebook A (etr_AAAAAA).html', bytes: '<html><body>A</body></html>' },
      { path: 'benchling.css', bytes: 'body { color: #222; }' },
    ]);

    await expect(inspectNativeExportArchive(archive)).rejects.toThrow(/duplicate path/iu);
  });
});
