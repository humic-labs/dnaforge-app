import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bundleFileContentSha256,
  classifyNewBundleFileCandidates,
  classifyValidatedNotebookAssetPath,
  classifyShareFile,
  classifyShareFileForNewBundle,
  bundleContainsLegacyLimsExport,
  DESKTOP_SYNC_BUNDLE_JSON_MAX_BYTES,
  DESKTOP_SYNC_HOSTED_PLATFORM_BODY_MAX_BYTES,
  DESKTOP_SYNC_LATEST_JSON_MAX_BYTES,
  decodeBundleFileContent,
  DEFAULT_WORKSPACE_SYNC_ENCODED_BUNDLE_MAX_BYTES,
  DEFAULT_SHARE_BUNDLE_LIMITS,
  DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS,
  DEFAULT_WORKSPACE_SYNC_MANIFEST_LIMITS,
  isSafeRelativePath,
  MAX_PORTABLE_SEQUENCE_PACKAGE_FORMAT_VERSION,
  resolveWorkspaceSyncBundleLimits,
  resolveWorkspaceSyncManifestLimits,
  resolveWorkspaceSyncEncodedBundleMaxBytes,
  workspaceSyncBundleHashInput,
  workspaceSyncResourceMediaType,
  workspaceSyncVersionRequestHashInput,
  validateShareBundle,
  validateNewBundleFilePolicy,
  validateWorkspaceSyncBundle,
  validateWorkspaceSyncBundleV1,
  validateWorkspaceSyncBundleV2,
  validateWorkspaceSyncUploadAdmission,
  WORKSPACE_SYNC_BUNDLE_V1_READ_LIMITS,
  workspaceSyncUploadWireBytes,
  type ShareBundle,
  type WorkspaceSyncBundleV1,
  type WorkspaceSyncBundleV2,
} from './index';

describe('share bundle contract', () => {
  it.each([
    ['Molecular views/Pocket.dnaforge-molecular.json', 'molecular-document', 'application/json'],
    ['structures/model.pdb', 'structure', 'text/plain'],
    ['structures/model.mmcif', 'structure', 'text/plain'],
    ['structures/model.cif', 'structure', 'text/plain'],
    ['structures/model.bcif', 'structure', 'application/octet-stream'],
  ])(
    'retains molecular document or raw structure %s in portable bundles',
    (path, kind, contentType) => {
      expect(classifyShareFileForNewBundle(path, 123)).toEqual({
        action: 'include',
        kind,
        contentType,
      });
    }
  );
  it.each([
    ['notes.txt', 'text/plain'],
    ['data.tsv', 'text/tab-separated-values'],
    ['preview.PNG', 'image/png'],
    ['preview.jpeg', 'image/jpeg'],
    ['drawing.svg', 'image/svg+xml'],
  ])('recognizes private resource %s without admitting a public design', (path, mediaType) => {
    expect(workspaceSyncResourceMediaType(path)).toBe(mediaType);
    expect(classifyShareFileForNewBundle(path, 12)).toEqual({
      action: 'exclude',
      reason: 'unsupported',
    });
  });

  it.each([
    '../notes.txt',
    '.secrets.txt',
    'private/.keys/data.json',
    'NUL.png',
    'reads.fastq',
    'index.fai',
  ])('does not admit unsafe or operational resource %s', (path) => {
    expect(workspaceSyncResourceMediaType(path)).toBeNull();
  });

  it('decodes a real multi-megabyte canonical binary payload without exhausting the regular expression stack', () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 73);
    const decoded = decodeBundleFileContent({
      encoding: 'base64',
      content: bytes.toString('base64'),
    });
    expect(decoded.byteLength).toBe(bytes.length);
    expect(createHash('sha256').update(decoded).digest('hex')).toBe(
      createHash('sha256').update(bytes).digest('hex')
    );
  });

  it('keeps structural streamed bounds independent from commercial policy and inline caps', () => {
    const manifestLimits = resolveWorkspaceSyncManifestLimits({});
    expect(manifestLimits).toEqual({
      maxFileBytes: Number.MAX_SAFE_INTEGER,
      maxBundleBytes: Number.MAX_SAFE_INTEGER,
      maxFiles: 2000,
    });
    expect(manifestLimits).toEqual(DEFAULT_WORKSPACE_SYNC_MANIFEST_LIMITS);
    expect(
      classifyShareFileForNewBundle('large.fasta', 50 * 1024 * 1024, manifestLimits)
    ).toMatchObject({
      action: 'include',
      kind: 'fasta',
    });
    expect(
      classifyShareFileForNewBundle(
        'large.fasta',
        50 * 1024 * 1024,
        resolveWorkspaceSyncBundleLimits({})
      )
    ).toEqual({ action: 'exclude', reason: 'file-too-large' });
    expect(
      classifyShareFileForNewBundle('private.fastq', 50 * 1024 * 1024, manifestLimits)
    ).toEqual({
      action: 'exclude',
      reason: 'private-raw-data',
    });
    expect(
      classifyShareFileForNewBundle(
        'too-large.fasta',
        manifestLimits.maxFileBytes + 1,
        manifestLimits
      )
    ).toEqual({ action: 'exclude', reason: 'file-too-large' });
  });

  it('bounds legacy streamed environment settings by protocol limits rather than a commercial allowance', () => {
    expect(
      resolveWorkspaceSyncManifestLimits({
        DNAFORGE_SYNC_MAX_FILE_BYTES: String(64 * 1024 * 1024),
        DNAFORGE_SYNC_MAX_BUNDLE_BYTES: String(128 * 1024 * 1024),
        DNAFORGE_SYNC_MAX_FILES: '12',
      })
    ).toEqual({ maxFileBytes: 64 * 1024 * 1024, maxBundleBytes: 128 * 1024 * 1024, maxFiles: 12 });
    expect(
      resolveWorkspaceSyncManifestLimits({
        DNAFORGE_SYNC_MAX_FILE_BYTES: String(50 * 1024 * 1024 * 1024),
        DNAFORGE_SYNC_MAX_BUNDLE_BYTES: String(50 * 1024 * 1024 * 1024),
        DNAFORGE_SYNC_MAX_FILES: '999999',
      })
    ).toEqual({
      maxFileBytes: 50 * 1024 ** 3,
      maxBundleBytes: 50 * 1024 ** 3,
      maxFiles: 2000,
    });
  });

  it('keeps legacy backup/share caps independent from hosted desktop sync caps', () => {
    expect(DEFAULT_SHARE_BUNDLE_LIMITS).toEqual({
      maxFileBytes: 32 * 1024 * 1024,
      maxBundleBytes: 256 * 1024 * 1024,
      maxFiles: 2000,
    });
    expect(DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS).toEqual({
      maxFileBytes: 32 * 1024 * 1024,
      maxBundleBytes: 256 * 1024 * 1024,
      maxFiles: 2000,
    });
    expect(WORKSPACE_SYNC_BUNDLE_V1_READ_LIMITS).toBe(DEFAULT_SHARE_BUNDLE_LIMITS);
    expect(DEFAULT_WORKSPACE_SYNC_ENCODED_BUNDLE_MAX_BYTES).toBe(384 * 1024 * 1024);
  });

  it('keeps upload and latest-response bodies below the hosted platform ceiling', () => {
    expect(DESKTOP_SYNC_BUNDLE_JSON_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(DESKTOP_SYNC_LATEST_JSON_MAX_BYTES).toBe(
      DESKTOP_SYNC_BUNDLE_JSON_MAX_BYTES + 256 * 1024
    );
    expect(DESKTOP_SYNC_BUNDLE_JSON_MAX_BYTES).toBeLessThan(
      DESKTOP_SYNC_HOSTED_PLATFORM_BODY_MAX_BYTES
    );
    expect(DESKTOP_SYNC_LATEST_JSON_MAX_BYTES).toBeLessThan(
      DESKTOP_SYNC_HOSTED_PLATFORM_BODY_MAX_BYTES
    );
  });

  it('allows operational overrides within the raised hosted sync ceilings', () => {
    expect(
      resolveWorkspaceSyncBundleLimits({
        DNAFORGE_SYNC_MAX_FILE_BYTES: '1024',
        DNAFORGE_SYNC_MAX_BUNDLE_BYTES: '2048',
        DNAFORGE_SYNC_MAX_FILES: '3',
      })
    ).toEqual({ maxFileBytes: 1024, maxBundleBytes: 2048, maxFiles: 3 });
    expect(
      resolveWorkspaceSyncBundleLimits({
        DNAFORGE_SYNC_MAX_FILE_BYTES: String(64 * 1024 * 1024),
        DNAFORGE_SYNC_MAX_BUNDLE_BYTES: String(512 * 1024 * 1024),
        DNAFORGE_SYNC_MAX_FILES: '4000',
      })
    ).toEqual(DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS);
    expect(
      resolveWorkspaceSyncEncodedBundleMaxBytes({
        DNAFORGE_SYNC_MAX_ENCODED_BUNDLE_BYTES: String(20 * 1024 * 1024),
      })
    ).toBe(20 * 1024 * 1024);
    expect(
      resolveWorkspaceSyncEncodedBundleMaxBytes({
        DNAFORGE_SYNC_MAX_ENCODED_BUNDLE_BYTES: String(512 * 1024 * 1024),
      })
    ).toBe(DEFAULT_WORKSPACE_SYNC_ENCODED_BUNDLE_MAX_BYTES);
  });

  it('includes small design artifacts and excludes raw/reference data by pointer-not-bytes policy', () => {
    expect(classifyShareFile('Project/plasmid.gb', 1024)).toMatchObject({
      action: 'include',
      kind: 'genbank',
    });
    expect(classifyShareFile('Project/notes.wpnote.json', 1024)).toMatchObject({
      action: 'include',
      kind: 'notebook',
    });
    expect(classifyShareFile('Project/Assemble.wpdesign.json', 1024)).toMatchObject({
      action: 'include',
      kind: 'design',
    });
    expect(classifyShareFile('Project/run.fastq', 1024)).toMatchObject({
      action: 'exclude',
      reason: 'private-raw-data',
    });
    expect(classifyShareFile('Project/reference.gff3', 1024)).toMatchObject({
      action: 'exclude',
      reason: 'reference-pointer',
    });
    expect(
      classifyShareFile('Project/large.gb', DEFAULT_SHARE_BUNDLE_LIMITS.maxFileBytes + 1)
    ).toMatchObject({
      action: 'exclude',
      reason: 'file-too-large',
    });
  });

  it('keeps legacy LIMS paths readable while excluding them from new bundles', () => {
    expect(classifyShareFile('.waypoint/lims/manifest.json', 128)).toMatchObject({
      action: 'include',
      kind: 'lims-manifest',
    });
    expect(classifyShareFile('.waypoint/lims/log/2026-07.jsonl', 256)).toMatchObject({
      action: 'include',
      kind: 'lims-audit-log',
    });
    expect(classifyShareFile('.waypoint/lims/sheets/oligos.csv', 64)).toMatchObject({
      action: 'include',
      kind: 'lims-sheet',
    });
    expect(classifyShareFileForNewBundle('.waypoint/lims/manifest.json', 128)).toEqual({
      action: 'exclude',
      reason: 'unsupported',
    });
    expect(classifyShareFileForNewBundle('.waypoint/lims/log/2026-07.jsonl', 256)).toEqual({
      action: 'exclude',
      reason: 'unsupported',
    });
    expect(classifyShareFileForNewBundle('.waypoint/lims/sheets/oligos.csv', 64)).toEqual({
      action: 'exclude',
      reason: 'unsupported',
    });
    expect(classifyShareFile('Project/notes.jsonl', 64)).toMatchObject({
      action: 'exclude',
      reason: 'unsupported',
    });
    expect(classifyShareFile('Project/oligos.csv', 64)).toMatchObject({
      action: 'exclude',
      reason: 'unsupported',
    });
    expect(classifyShareFile('.waypoint/lims/notes.txt', 64)).toMatchObject({
      action: 'exclude',
      reason: 'unsupported',
    });
    expect(classifyShareFile('.waypoint/lims/raw/reads.bam', 1024)).toMatchObject({
      action: 'exclude',
      reason: 'private-raw-data',
    });
  });

  it('excludes local migration journals, source locators, and transaction files from new bundles', () => {
    for (const path of [
      '.dnaforge/migration/actions/action-1.json',
      '.dnaforge/migration/source-artifact.json',
      '.dnaforge/migration/migration.sqlite',
      '.dnaforge/migration/rollback/action/prior.gb',
      'Selected Root/.Plasmid.gb.1234.dnaforge-migration.tmp',
    ]) {
      expect(classifyShareFileForNewBundle(path, 128)).toEqual({
        action: 'exclude',
        reason: 'unsupported',
      });
    }
    expect(classifyShareFileForNewBundle('.dnaforge/native-workspace.json', 128)).toEqual({
      action: 'include',
      kind: 'native-workspace-manifest',
      contentType: 'application/json',
    });
    expect(classifyShareFileForNewBundle('.forge/catalog.json', 128)).toEqual({
      action: 'include',
      kind: 'native-workspace-manifest',
      contentType: 'application/json',
    });
    expect(classifyShareFileForNewBundle('unrelated/.forge/catalog.json', 128)).toEqual({
      action: 'exclude',
      reason: 'unsupported',
    });
  });

  it('includes vault-shaped notebook package members and legacy .wpnote.json', () => {
    expect(classifyShareFile('Lab notes/.forge/notebook.json', 128)).toMatchObject({
      action: 'include',
      kind: 'notebook',
      contentType: 'application/json',
    });
    expect(classifyShareFile('Lab notes/Lab notes.md', 64)).toMatchObject({
      action: 'include',
      kind: 'notebook',
      contentType: 'text/markdown',
    });
    expect(classifyShareFile('Lab notes/.forge/blocks/abc123.json', 64)).toMatchObject({
      action: 'include',
      kind: 'notebook',
      contentType: 'application/json',
    });
    expect(classifyShareFile('Lab notes/assets/model.bin', 3)).toMatchObject({
      action: 'exclude',
      reason: 'unsupported',
    });
    expect(
      classifyValidatedNotebookAssetPath('Lab notes/assets/model.bin', 'Lab notes', 3)
    ).toMatchObject({
      action: 'include',
      kind: 'notebook',
      contentType: 'application/octet-stream',
    });
    expect(classifyShareFile('readme.md', 64)).toMatchObject({
      action: 'exclude',
      reason: 'unsupported',
    });
    expect(classifyShareFile('Project/notes.wpnote.json', 1024)).toMatchObject({
      action: 'include',
      kind: 'notebook',
    });
  });

  it('rejects unsafe relative paths in validation', () => {
    expect(isSafeRelativePath('Project/plasmid.gb')).toBe(true);
    expect(isSafeRelativePath('../secret.gb')).toBe(false);
    expect(isSafeRelativePath('/Users/me/secret.gb')).toBe(false);

    const bundle: ShareBundle = {
      schemaVersion: 1,
      capturedAt: '2026-07-07T00:00:00.000Z',
      workspace: { id: 'desktop-1', name: 'Project' },
      files: [
        {
          id: 'file-1',
          relativePath: '../secret.gb',
          name: 'secret.gb',
          kind: 'genbank',
          contentType: 'text/plain',
          sizeBytes: 4,
          sha256: 'a'.repeat(64),
          content: 'ATGC',
        },
      ],
      excludedFiles: [],
      limits: DEFAULT_SHARE_BUNDLE_LIMITS,
      provenance: {
        source: 'dnaforge-desktop',
        appVersion: '0.4.0',
        contentSha256: 'b'.repeat(64),
      },
    };

    expect(validateShareBundle(bundle)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['files[0].relativePath is unsafe']),
    });

    const safeFile = { ...bundle.files[0], relativePath: 'Project/plasmid.gb' };
    expect(
      validateShareBundle({
        ...bundle,
        files: [safeFile, { ...safeFile, id: 'file-2' }],
      })
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['files[1].relativePath is duplicated']),
    });
    expect(
      validateShareBundle({
        ...bundle,
        files: [safeFile, { ...safeFile, id: 'file-2', relativePath: 'project/PLASMID.gb' }],
      })
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['files[1].relativePath collides case-insensitively']),
    });
  });
});

describe('workspace sync bundle v1 contract', () => {
  function validSyncBundle(overrides: Partial<WorkspaceSyncBundleV1> = {}): WorkspaceSyncBundleV1 {
    const fileContent = 'LOCUS       pUC19\nORIGIN\n        1 atgc\n//\n';
    const file = {
      id: 'file-1',
      relativePath: 'Project/plasmid.gb',
      name: 'plasmid.gb',
      kind: 'genbank' as const,
      contentType: 'text/plain',
      sizeBytes: 43,
      sha256: '8b3067c2c27a7e715fbf841fd85e4df135d51cd9f3a41b1a36f7b590692bd06b',
      content: fileContent,
    };

    return {
      schemaVersion: 1,
      capturedAt: '2026-07-08T00:00:00.000Z',
      workspace: { id: 'repo-uuid-1', name: 'Project' },
      files: [file],
      excludedSummary: {
        unsupported: { count: 0, bytesApprox: 0 },
        'private-raw-data': { count: 0, bytesApprox: 0 },
        'reference-pointer': { count: 0, bytesApprox: 0 },
        'file-too-large': { count: 0, bytesApprox: 0 },
        'bundle-too-large': { count: 0, bytesApprox: 0 },
      },
      limits: DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS,
      provenance: {
        source: 'dnaforge-desktop',
        appVersion: '0.4.0',
        contentSha256: 'b'.repeat(64),
      },
      ...overrides,
    };
  }

  it('keeps private manifest resources out of legacy sync bundle decoders', () => {
    const bundle = validSyncBundle();
    expect(validateWorkspaceSyncBundleV1(bundle)).toMatchObject({ ok: true });
    const resources = [
      {
        ...bundle.files[0],
        relativePath: 'notes.txt',
        name: 'notes.txt',
        kind: 'workspace-resource' as const,
      },
    ];
    const privateBundle = { ...bundle, files: resources };
    expect(validateWorkspaceSyncBundleV1(privateBundle)).toMatchObject({ ok: false });
    expect(validateWorkspaceSyncBundleV2({ ...privateBundle, schemaVersion: 2 })).toMatchObject({
      ok: false,
    });
    expect(validateNewBundleFilePolicy(privateBundle)).toMatchObject({ ok: false });
  });

  it('measures the exact JSON wire expansion for quoted and control-character content', () => {
    const bundle = validSyncBundle();
    bundle.files[0] = {
      ...bundle.files[0],
      content: 'quoted "value"\ncontrol\u0000',
    };
    const expected = Buffer.byteLength(
      JSON.stringify({ baseVersionId: 'version-1', bundle }),
      'utf8'
    );

    expect(workspaceSyncUploadWireBytes('version-1', bundle)).toBe(expected);
    expect(expected).toBeGreaterThan(Buffer.byteLength(bundle.files[0].content, 'utf8'));
  });

  it('accepts the sync bundle shape without legacy excluded file paths', () => {
    const bundle = validSyncBundle();

    expect(validateWorkspaceSyncBundleV1(bundle)).toMatchObject({ ok: true });
    expect(bundleContainsLegacyLimsExport(bundle)).toBe(false);
    expect(validateNewBundleFilePolicy(bundle)).toMatchObject({ ok: true });
    expect(validateWorkspaceSyncUploadAdmission(bundle)).toMatchObject({ ok: true });
  });

  it('accepts a stored V1 bundle near the raised new-upload ceiling', () => {
    const content = 'A'.repeat(31 * 1024 * 1024);
    const base = validSyncBundle();
    const bundle = validSyncBundle({
      files: [
        {
          ...base.files[0],
          content,
          sizeBytes: Buffer.byteLength(content, 'utf8'),
          sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
        },
      ],
    });

    expect(validateWorkspaceSyncBundleV1(bundle)).toMatchObject({ ok: true });
    expect(validateWorkspaceSyncUploadAdmission(bundle)).toMatchObject({ ok: true });
  });

  it.each([
    ['v1', undefined],
    ['v2', 2],
    ['v3', 3],
  ])(
    'keeps a stored V1 bundle with a historical %s sequence package readable',
    (label, version) => {
      const markerContent = JSON.stringify({
        schema: version === undefined ? 'waypoint.plasmid.v1' : 'waypoint.sequence.v1',
        kind: version === undefined ? 'plasmid' : 'sequence',
        ...(version === undefined ? {} : { formatVersion: version }),
        id: `historical-${label}`,
        name: 'pHistorical',
        updatedAt: '2026-07-08T00:00:00.000Z',
        product: { file: 'pHistorical.gb', topology: 'circular' },
        members: [],
      });
      const productContent = 'LOCUS       pHistorical\nORIGIN\n        1 atgc\n//\n';
      const base = validSyncBundle();
      const markerBytes = Buffer.from(markerContent, 'utf8');
      const productBytes = Buffer.from(productContent, 'utf8');
      const bundle = validSyncBundle({
        files: [
          {
            ...base.files[0],
            id: `historical-${label}-marker`,
            relativePath: 'pHistorical/.forge/plasmid.json',
            name: 'plasmid.json',
            kind: 'assembly-sidecar',
            contentType: 'application/json',
            content: markerContent,
            sizeBytes: markerBytes.byteLength,
            sha256: createHash('sha256').update(markerBytes).digest('hex'),
          },
          {
            ...base.files[0],
            id: `historical-${label}-product`,
            relativePath: 'pHistorical/pHistorical.gb',
            name: 'pHistorical.gb',
            content: productContent,
            sizeBytes: productBytes.byteLength,
            sha256: createHash('sha256').update(productBytes).digest('hex'),
          },
        ],
      });

      expect(validateWorkspaceSyncBundleV1(bundle)).toMatchObject({ ok: true });
      expect(validateNewBundleFilePolicy(bundle)).toMatchObject({ ok: true });
    }
  );

  it('accepts a stored V1 bundle containing the legacy LIMS export allowlist', () => {
    const content = '{"schemaVersion":1}\n';
    const base = validSyncBundle();
    const bundle = validSyncBundle({
      files: [
        {
          ...base.files[0],
          id: 'legacy-lims-manifest',
          relativePath: '.waypoint/lims/manifest.json',
          name: 'manifest.json',
          kind: 'lims-manifest',
          contentType: 'application/json',
          content,
          sizeBytes: Buffer.byteLength(content, 'utf8'),
          sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
        },
      ],
    });

    expect(validateWorkspaceSyncBundleV1(bundle)).toMatchObject({ ok: true });
    expect(bundleContainsLegacyLimsExport(bundle)).toBe(true);
    expect(validateNewBundleFilePolicy(bundle)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'files[0].relativePath is excluded from new bundles (unsupported)',
      ]),
    });
    expect(validateWorkspaceSyncUploadAdmission(bundle)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'files[0].relativePath is excluded from new bundles (unsupported)',
      ]),
    });
  });

  it('rejects encoded JSON expansion independently from raw-content admission', () => {
    const content = '"'.repeat(6 * 1024 * 1024);
    const base = validSyncBundle();
    const bundle = validSyncBundle({
      files: [
        {
          ...base.files[0],
          content,
          sizeBytes: Buffer.byteLength(content, 'utf8'),
          sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
        },
      ],
    });
    const admission = validateWorkspaceSyncUploadAdmission(bundle, { maxEncodedBundleBytes: 1024 });

    expect(admission.rawContentBytes).toBe(6 * 1024 * 1024);
    expect(admission.encodedBundleBytes).toBeGreaterThan(1024);
    expect(admission).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'encoded bundle JSON exceeds the new-upload encoded-bundle limit',
      ]),
    });
  });

  it('keeps v1 UTF-8-only and validates binary notebook assets under schema v2', () => {
    const base = validSyncBundle();
    const metadata = {
      schema: 'waypoint.notebook.v1',
      kind: 'notebook',
      formatVersion: 2,
      id: 'notebook-1',
      title: 'Lab notes',
      updatedAt: '2026-07-08T00:00:00.000Z',
      authority: { type: 'markdown', path: 'Lab notes.md', codec: 'dnaforge.notebook-markdown.v1' },
      payloads: { blocksDirectory: 'blocks', schema: 'waypoint.notebook.block.v1' },
    };
    const metadataContent = JSON.stringify(metadata);
    const metadataFile = {
      id: 'notebook-marker',
      relativePath: 'Lab notes/.forge/notebook.json',
      name: 'notebook.json',
      kind: 'notebook' as const,
      contentType: 'application/json',
      sizeBytes: Buffer.byteLength(metadataContent),
      sha256: bundleFileContentSha256({ content: metadataContent }),
      content: metadataContent,
    };
    const binaryFile = {
      id: 'binary-asset',
      relativePath: 'Lab notes/assets/model.bin',
      name: 'model.bin',
      kind: 'notebook' as const,
      contentType: 'application/octet-stream',
      sizeBytes: 3,
      sha256: 'ef192b7af54e943f206ab27075ec1805384c972c9959fc5820f1fa7d5268fcef',
      content: '/wCA',
      encoding: 'base64' as const,
    };
    const bundle: WorkspaceSyncBundleV2 = {
      ...base,
      schemaVersion: 2,
      files: [metadataFile, binaryFile],
    };

    expect(validateWorkspaceSyncBundleV1(bundle)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['schemaVersion must be 1']),
    });
    expect(validateWorkspaceSyncBundleV2(bundle)).toMatchObject({ ok: true });
    expect(validateWorkspaceSyncBundle(bundle)).toMatchObject({ ok: true });
    expect([...decodeBundleFileContent(binaryFile)]).toEqual([255, 0, 128]);
    expect(bundleFileContentSha256(binaryFile)).toBe(binaryFile.sha256);

    expect(
      validateWorkspaceSyncBundleV2({
        ...bundle,
        files: [metadataFile, { ...binaryFile, content: '/wC!' }],
      })
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['files[1].content is not valid for its encoding']),
    });

    const incompatibleMetadataContent = JSON.stringify({
      ...metadata,
      payloads: { blocksDirectory: 'blocks', schema: 'waypoint.notebook.block.v99' },
    });
    const incompatibleMetadataFile = {
      ...metadataFile,
      sizeBytes: Buffer.byteLength(incompatibleMetadataContent),
      sha256: bundleFileContentSha256({ content: incompatibleMetadataContent }),
      content: incompatibleMetadataContent,
    };
    expect(
      validateWorkspaceSyncBundleV2({
        ...bundle,
        files: [incompatibleMetadataFile, binaryFile],
      })
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['files[1].relativePath is unsupported']),
    });
  });

  it('rejects legacy ShareBundle excludedFiles metadata in the sync wire shape', () => {
    const bundle = {
      ...validSyncBundle(),
      excludedFiles: [{ relativePath: 'private/sample.fastq', reason: 'private-raw-data' }],
    };

    expect(validateWorkspaceSyncBundleV1(bundle)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['excludedFiles is not allowed in WorkspaceSyncBundleV1']),
    });
  });

  it('rejects excluded path metadata inside excludedSummary', () => {
    const bundle = validSyncBundle({
      excludedSummary: {
        unsupported: { count: 0, bytesApprox: 0 },
        'private-raw-data': {
          count: 1,
          bytesApprox: 128,
          relativePaths: ['private/sample.fastq'],
        } as never,
        'reference-pointer': { count: 0, bytesApprox: 0 },
        'file-too-large': { count: 0, bytesApprox: 0 },
        'bundle-too-large': { count: 0, bytesApprox: 0 },
      },
    });

    expect(validateWorkspaceSyncBundleV1(bundle)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'excludedSummary must contain aggregate excluded-file counts only',
      ]),
    });
  });

  it('recomputes file kind, content type, byte size, and sha256 from path and content', () => {
    const base = validSyncBundle();

    expect(
      validateWorkspaceSyncBundleV1({
        ...base,
        files: [{ ...base.files[0], sizeBytes: 999 }],
      })
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['files[0].sizeBytes does not match decoded content length']),
    });

    expect(
      validateWorkspaceSyncBundleV1({
        ...base,
        files: [{ ...base.files[0], sha256: 'c'.repeat(64) }],
      })
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['files[0].sha256 does not match content']),
    });

    expect(
      validateWorkspaceSyncBundleV1({
        ...base,
        files: [{ ...base.files[0], kind: 'fasta', contentType: 'application/json' }],
      })
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'files[0].kind does not match relativePath',
        'files[0].contentType does not match relativePath',
      ]),
    });
  });

  it('rejects unsafe, duplicate, reserved, raw, reference, and unsupported paths', () => {
    const base = validSyncBundle();
    const cases: Array<[string, string]> = [
      ['/absolute/plasmid.gb', 'files[0].relativePath is unsafe'],
      [' Project/plasmid.gb', 'files[0].relativePath is unsafe'],
      ['Project/plasmid.gb ', 'files[0].relativePath is unsafe'],
      ['C:/Project/plasmid.gb', 'files[0].relativePath is unsafe'],
      ['C:Project/plasmid.gb', 'files[0].relativePath is unsafe'],
      ['Project/../plasmid.gb', 'files[0].relativePath is unsafe'],
      ['Project/CON.gb', 'files[0].relativePath uses a reserved Windows name'],
      ['Project/run.fastq', 'files[0].relativePath is private raw data'],
      ['Project/reference.gff3', 'files[0].relativePath is a reference pointer'],
      ['Project/readme.txt', 'files[0].relativePath is unsupported'],
    ];

    for (const [relativePath, error] of cases) {
      expect(
        validateWorkspaceSyncBundleV1({
          ...base,
          files: [{ ...base.files[0], relativePath, name: relativePath.split('/').at(-1) ?? 'x' }],
        })
      ).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([error]),
      });
    }

    expect(
      validateWorkspaceSyncBundleV1({
        ...base,
        files: [
          base.files[0],
          { ...base.files[0], id: 'file-2', relativePath: 'project/PLASMID.gb' },
        ],
      })
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['files[1].relativePath collides case-insensitively']),
    });
  });

  it('enforces server file-count limits even when the bundle claims higher limits', () => {
    const base = validSyncBundle();
    const files = Array.from(
      { length: DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS.maxFiles + 1 },
      (_, index) => ({
        ...base.files[0],
        id: `file-${index}`,
        relativePath: `Project/plasmid-${index}.gb`,
        name: `plasmid-${index}.gb`,
      })
    );

    expect(
      validateWorkspaceSyncBundleV1({
        ...base,
        limits: {
          ...DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS,
          maxFiles: DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS.maxFiles + 1,
        },
        files,
      })
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        `files must contain at most ${DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS.maxFiles} entries`,
      ]),
    });
  });

  it('hashes the sync-specific accepted shape canonically with provenance.contentSha256 blanked', () => {
    const bundle = validSyncBundle();
    const reordered = {
      provenance: {
        contentSha256: bundle.provenance.contentSha256,
        appVersion: bundle.provenance.appVersion,
        source: bundle.provenance.source,
      },
      limits: {
        maxFiles: bundle.limits.maxFiles,
        maxBundleBytes: bundle.limits.maxBundleBytes,
        maxFileBytes: bundle.limits.maxFileBytes,
      },
      excludedSummary: {
        'bundle-too-large': bundle.excludedSummary['bundle-too-large'],
        'file-too-large': bundle.excludedSummary['file-too-large'],
        'reference-pointer': bundle.excludedSummary['reference-pointer'],
        'private-raw-data': bundle.excludedSummary['private-raw-data'],
        unsupported: bundle.excludedSummary.unsupported,
      },
      files: bundle.files.map((file) => ({
        content: file.content,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        contentType: file.contentType,
        kind: file.kind,
        name: file.name,
        relativePath: file.relativePath,
        id: file.id,
      })),
      workspace: { name: bundle.workspace.name, id: bundle.workspace.id },
      capturedAt: bundle.capturedAt,
      schemaVersion: bundle.schemaVersion,
    } as WorkspaceSyncBundleV1;

    expect(workspaceSyncBundleHashInput(bundle)).toContain('"excludedSummary"');
    expect(workspaceSyncBundleHashInput(bundle)).not.toContain('"excludedFiles"');
    expect(workspaceSyncBundleHashInput(bundle)).not.toContain('b'.repeat(64));
    expect(workspaceSyncBundleHashInput(bundle)).toContain('"contentSha256":""');
    expect(validateWorkspaceSyncBundleV1(reordered)).toMatchObject({ ok: true });
    expect(workspaceSyncBundleHashInput(reordered)).toBe(workspaceSyncBundleHashInput(bundle));
    expect(workspaceSyncVersionRequestHashInput(null, reordered)).toBe(
      workspaceSyncVersionRequestHashInput(null, bundle)
    );
  });

  it('ignores capturedAt when hashing sync content and upload requests', () => {
    const earlier = validSyncBundle();
    const later = {
      ...earlier,
      capturedAt: '2026-07-09T12:00:00.000Z',
    } as WorkspaceSyncBundleV1;

    expect(workspaceSyncBundleHashInput(later)).toBe(workspaceSyncBundleHashInput(earlier));
    expect(workspaceSyncVersionRequestHashInput(null, later)).toBe(
      workspaceSyncVersionRequestHashInput(null, earlier)
    );
    expect(workspaceSyncBundleHashInput(earlier)).not.toContain('"capturedAt":"2026');
  });
});

describe('plasmid package member classification ', () => {
  const limits = { maxFileBytes: 10_000_000, maxBundleBytes: 100_000_000, maxFiles: 1000 };

  it('includes the package build record', () => {
    expect(classifyShareFile('pMyConstruct/.forge/plasmid.json', 2048, limits)).toEqual({
      action: 'include',
      kind: 'assembly-sidecar',
      contentType: 'application/json',
    });
  });

  it('includes every other package member', () => {
    for (const extension of ['gb', 'gbk', 'gbff', 'genbank']) {
      expect(
        classifyShareFile(`pMyConstruct/pMyConstruct.${extension}`, 4096, limits)
      ).toMatchObject({
        action: 'include',
        kind: 'genbank',
      });
    }
    expect(
      classifyShareFile('pMyConstruct/primers/pMyConstruct.primers.csv', 512, limits)
    ).toMatchObject({ action: 'include', kind: 'primer-table' });
    expect(
      classifyShareFile('pMyConstruct/primers/pMyConstruct.primers.fasta', 512, limits)
    ).toMatchObject({ action: 'include', kind: 'primer-table' });
    expect(
      classifyShareFile('pMyConstruct/contents/pMyConstruct.primers.csv', 512, limits)
    ).toMatchObject({ action: 'include', kind: 'primer-table' });
    expect(
      classifyShareFile('pMyConstruct/contents/pMyConstruct.gb.waypoint.json', 512, limits)
    ).toMatchObject({ action: 'include', kind: 'assembly-sidecar' });
    expect(classifyShareFile('pMyConstruct/contents/clone-1.fasta', 512, limits)).toMatchObject({
      action: 'include',
      kind: 'fasta',
    });
  });

  it('still includes a legacy flat sidecar', () => {
    expect(
      classifyShareFile('assemblies/final.waypoint-assembly.json', 2048, limits)
    ).toMatchObject({ action: 'include', kind: 'assembly-sidecar' });
  });

  it('excludes an oversized record rather than silently truncating it', () => {
    expect(classifyShareFile('pMyConstruct/.forge/plasmid.json', 20_000_000, limits)).toMatchObject(
      { action: 'exclude', reason: 'file-too-large' }
    );
  });

  it('does not claim a notebook package meta as an assembly record', () => {
    expect(classifyShareFile('Lab notes/.forge/notebook.json', 100, limits)).toMatchObject({
      action: 'include',
      kind: 'notebook',
    });
  });
});

describe('sequence package portable authority ', () => {
  const productContent =
    'LOCUS       pRoundTrip  8 bp    DNA     circular\nORIGIN\n        1 atgcgtac\n//\n';
  const binaryContent = Buffer.from([0xff, 0x00, 0x80, 0x44]);
  const binaryMember = {
    id: 'member-binary',
    role: 'user',
    path: 'contents/calibration.bin',
    replaceable: false,
    createdAt: '2026-08-27T00:00:00.000Z',
    mediaType: 'application/octet-stream',
  };
  const markerDocument = {
    schema: 'waypoint.sequence.v1',
    kind: 'sequence',
    formatVersion: MAX_PORTABLE_SEQUENCE_PACKAGE_FORMAT_VERSION,
    id: 'sequence-roundtrip-id',
    name: 'pRoundTrip',
    updatedAt: '2026-08-27T00:00:00.000Z',
    product: { file: 'pRoundTrip.gb', topology: 'circular' },
    members: [binaryMember],
    versionHistory: {
      schema: 'waypoint.sequence-history.v1',
      headId: null,
      revisions: [],
    },
  };
  const markerContent = JSON.stringify(markerDocument);

  function file(input: {
    id: string;
    relativePath: string;
    kind: 'genbank' | 'assembly-sidecar';
    contentType: string;
    bytes: Buffer;
    binary?: boolean;
  }): WorkspaceSyncBundleV2['files'][number] {
    return {
      id: input.id,
      relativePath: input.relativePath,
      name: input.relativePath.split('/').at(-1) ?? input.id,
      kind: input.kind,
      contentType: input.contentType,
      sizeBytes: input.bytes.byteLength,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
      content: input.binary ? input.bytes.toString('base64') : input.bytes.toString('utf8'),
      ...(input.binary ? { encoding: 'base64' as const } : {}),
    };
  }

  function sequencePackageBundle(files: WorkspaceSyncBundleV2['files']): WorkspaceSyncBundleV2 {
    return {
      schemaVersion: 2,
      capturedAt: '2026-08-27T00:00:00.000Z',
      workspace: { id: 'workspace-roundtrip', name: 'Round trip' },
      files,
      excludedSummary: {
        unsupported: { count: 0, bytesApprox: 0 },
        'private-raw-data': { count: 0, bytesApprox: 0 },
        'reference-pointer': { count: 0, bytesApprox: 0 },
        'file-too-large': { count: 0, bytesApprox: 0 },
        'bundle-too-large': { count: 0, bytesApprox: 0 },
      },
      limits: DEFAULT_WORKSPACE_SYNC_BUNDLE_LIMITS,
      provenance: {
        source: 'dnaforge-desktop',
        appVersion: '0.4.0',
        contentSha256: 'b'.repeat(64),
      },
    };
  }

  const markerFile = file({
    id: 'marker',
    relativePath: 'pRoundTrip/.forge/plasmid.json',
    kind: 'assembly-sidecar',
    contentType: 'application/json',
    bytes: Buffer.from(markerContent),
  });
  const productFile = file({
    id: 'product',
    relativePath: 'pRoundTrip/pRoundTrip.gb',
    kind: 'genbank',
    contentType: 'text/plain',
    bytes: Buffer.from(productContent),
  });
  const binaryFile = file({
    id: 'binary',
    relativePath: 'pRoundTrip/contents/calibration.bin',
    kind: 'assembly-sidecar',
    contentType: 'application/octet-stream',
    bytes: binaryContent,
    binary: true,
  });

  it('pins the portable authority parser to the current package layout', () => {
    expect(MAX_PORTABLE_SEQUENCE_PACKAGE_FORMAT_VERSION).toBe(9);
    expect(
      validateWorkspaceSyncBundleV2(sequencePackageBundle([markerFile, productFile, binaryFile]))
    ).toMatchObject({ ok: true });
  });

  it('accepts existing v8 packages after the v9 layout upgrade', () => {
    const legacyMarker = file({
      id: 'legacy-marker',
      relativePath: markerFile.relativePath,
      kind: 'assembly-sidecar',
      contentType: 'application/json',
      bytes: Buffer.from(JSON.stringify({ ...markerDocument, formatVersion: 8 })),
    });
    expect(
      validateWorkspaceSyncBundleV2(sequencePackageBundle([legacyMarker, productFile, binaryFile]))
    ).toMatchObject({ ok: true });
  });

  it('keeps every v7 revision snapshot inside the atomic package bundle', () => {
    const digest = createHash('sha256').update(productContent).digest('hex');
    const snapshotPath = `contents/sequence-snapshot-${digest}.gb`;
    const snapshotFile = file({
      id: 'snapshot',
      relativePath: `pRoundTrip/${snapshotPath}`,
      kind: 'genbank',
      contentType: 'text/plain',
      bytes: Buffer.from(productContent),
    });
    const versionedMarker = file({
      id: 'versioned-marker',
      relativePath: markerFile.relativePath,
      kind: 'assembly-sidecar',
      contentType: 'application/json',
      bytes: Buffer.from(
        JSON.stringify({
          ...markerDocument,
          members: [
            binaryMember,
            {
              id: `sequence-snapshot:sha256:${digest}`,
              role: 'sequence-snapshot',
              path: snapshotPath,
              replaceable: false,
              createdAt: '2026-08-27T00:00:00.000Z',
            },
          ],
          versionHistory: {
            schema: 'waypoint.sequence-history.v1',
            headId: 'revision-one',
            revisions: [
              {
                id: 'revision-one',
                parentId: null,
                operationId: 'adopt-one',
                productSnapshot: { path: snapshotPath, sha256: `sha256:${digest}` },
              },
            ],
          },
        })
      ),
    });
    expect(
      validateWorkspaceSyncBundleV2(
        sequencePackageBundle([versionedMarker, productFile, binaryFile, snapshotFile])
      )
    ).toMatchObject({ ok: true });
    expect(
      validateWorkspaceSyncBundleV2(
        sequencePackageBundle([versionedMarker, productFile, binaryFile])
      )
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        `sequence package pRoundTrip is incomplete: missing pRoundTrip/${snapshotPath}`,
      ]),
    });
  });

  it('classifies marker, product, and declared member as one atomic candidate group', () => {
    expect(classifyNewBundleFileCandidates([markerFile, productFile, binaryFile])).toEqual({
      ok: true,
      files: [
        {
          relativePath: markerFile.relativePath,
          classification: {
            action: 'include',
            kind: 'assembly-sidecar',
            contentType: 'application/json',
          },
          atomicSequencePackageRoot: 'pRoundTrip',
        },
        {
          relativePath: productFile.relativePath,
          classification: {
            action: 'include',
            kind: 'genbank',
            contentType: 'text/plain',
          },
          atomicSequencePackageRoot: 'pRoundTrip',
        },
        {
          relativePath: binaryFile.relativePath,
          classification: {
            action: 'include',
            kind: 'assembly-sidecar',
            contentType: 'application/octet-stream',
          },
          atomicSequencePackageRoot: 'pRoundTrip',
        },
      ],
    });
  });

  it('admits an opaque binary member only when the validated marker declares its exact path', () => {
    const bundle = sequencePackageBundle([markerFile, productFile, binaryFile]);

    expect(validateWorkspaceSyncBundleV2(bundle)).toMatchObject({ ok: true });
    expect(validateNewBundleFilePolicy(bundle)).toMatchObject({ ok: true });
    expect([...decodeBundleFileContent(binaryFile)]).toEqual([...binaryContent]);

    expect(
      validateWorkspaceSyncBundleV2(sequencePackageBundle([productFile, binaryFile]))
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['files[1].relativePath is unsupported']),
    });
  });

  it.each([
    ['product', [markerFile, binaryFile], 'pRoundTrip/pRoundTrip.gb'],
    ['declared member', [markerFile, productFile], 'pRoundTrip/contents/calibration.bin'],
  ])('rejects an atomic package missing its %s', (_label, files, missingPath) => {
    expect(validateWorkspaceSyncBundleV2(sequencePackageBundle(files))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        `sequence package pRoundTrip is incomplete: missing ${missingPath}`,
      ]),
    });
  });

  it('does not let an unsupported marker grant authority to opaque members', () => {
    const unsupportedMarkerContent = JSON.stringify({
      ...JSON.parse(markerContent),
      formatVersion: MAX_PORTABLE_SEQUENCE_PACKAGE_FORMAT_VERSION + 1,
    });
    const unsupportedMarker = file({
      id: 'marker-unsupported',
      relativePath: markerFile.relativePath,
      kind: 'assembly-sidecar',
      contentType: 'application/json',
      bytes: Buffer.from(unsupportedMarkerContent),
    });

    expect(
      validateWorkspaceSyncBundleV2(
        sequencePackageBundle([unsupportedMarker, productFile, binaryFile])
      )
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'sequence package pRoundTrip has unsupported authoritative state',
        'files[2].relativePath is unsupported',
      ]),
    });
  });

  it.each([
    ['package id', { ...markerDocument, id: undefined }],
    ['member id', { ...markerDocument, members: [{ ...binaryMember, id: undefined }] }],
    ['member role', { ...markerDocument, members: [{ ...binaryMember, role: undefined }] }],
    [
      'unsafe member path',
      { ...markerDocument, members: [{ ...binaryMember, path: 'contents/../escape.bin' }] },
    ],
    [
      'duplicate member path',
      {
        ...markerDocument,
        members: [binaryMember, { ...binaryMember, id: 'member-binary-duplicate' }],
      },
    ],
    [
      'duplicate member id',
      {
        ...markerDocument,
        members: [binaryMember, { ...binaryMember, path: 'contents/other.bin' }],
      },
    ],
  ])('does not let malformed %s authority grant opaque-file access', (field, marker) => {
    const malformedMarker = file({
      id: `marker-missing-${field.replace(' ', '-')}`,
      relativePath: markerFile.relativePath,
      kind: 'assembly-sidecar',
      contentType: 'application/json',
      bytes: Buffer.from(JSON.stringify(marker)),
    });

    expect(
      validateWorkspaceSyncBundleV2(
        sequencePackageBundle([malformedMarker, productFile, binaryFile])
      )
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'sequence package pRoundTrip has unsupported authoritative state',
        'files[2].relativePath is unsupported',
      ]),
    });
  });

  it('rejects duplicate stable package ids across different package roots', () => {
    const duplicateMarker = file({
      id: 'marker-duplicate-stable-id',
      relativePath: 'pDuplicate/.forge/plasmid.json',
      kind: 'assembly-sidecar',
      contentType: 'application/json',
      bytes: Buffer.from(markerContent),
    });
    const duplicateProduct = file({
      id: 'product-duplicate-stable-id',
      relativePath: 'pDuplicate/pRoundTrip.gb',
      kind: 'genbank',
      contentType: 'text/plain',
      bytes: Buffer.from(productContent),
    });
    const duplicateBinary = file({
      id: 'binary-duplicate-stable-id',
      relativePath: 'pDuplicate/contents/calibration.bin',
      kind: 'assembly-sidecar',
      contentType: 'application/octet-stream',
      bytes: binaryContent,
      binary: true,
    });

    expect(
      validateWorkspaceSyncBundleV2(
        sequencePackageBundle([
          markerFile,
          productFile,
          binaryFile,
          duplicateMarker,
          duplicateProduct,
          duplicateBinary,
        ])
      )
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'sequence package pDuplicate duplicates stable id sequence-roundtrip-id from pRoundTrip',
      ]),
    });
  });

  it.each(['fastq', 'bam', 'cram', 'vcf', 'ab1'])(
    'keeps a declared .%s raw-data canary outside the portable authority',
    (extension) => {
      const rawPath = `pRoundTrip/contents/excluded-canary.${extension}`;
      const rawMarkerContent = JSON.stringify({
        ...JSON.parse(markerContent),
        members: [
          {
            id: `member-${extension}`,
            role: 'sequencing-read',
            path: `contents/excluded-canary.${extension}`,
            replaceable: true,
            createdAt: '2026-08-27T00:00:00.000Z',
          },
        ],
      });
      const rawMarker = file({
        id: `marker-${extension}`,
        relativePath: markerFile.relativePath,
        kind: 'assembly-sidecar',
        contentType: 'application/json',
        bytes: Buffer.from(rawMarkerContent),
      });
      const rawFile = file({
        id: `raw-${extension}`,
        relativePath: rawPath,
        kind: 'assembly-sidecar',
        contentType: 'application/octet-stream',
        bytes: Buffer.from(`INERT_DNA2517_${extension.toUpperCase()}_CANARY`),
        binary: true,
      });

      expect(
        validateWorkspaceSyncBundleV2(sequencePackageBundle([rawMarker, productFile, rawFile]))
      ).toMatchObject({
        ok: false,
        errors: expect.arrayContaining([`files[2].relativePath is private raw data`]),
      });
    }
  );
});
