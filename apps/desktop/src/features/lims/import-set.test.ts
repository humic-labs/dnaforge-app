import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LimsImportPlan } from '../../shared/lims';

const fsMocks = vi.hoisted(() => ({
  exists: vi.fn(),
  readFile: vi.fn(),
  readTextFile: vi.fn(),
  sha256File: vi.fn(),
  writeWorkspaceBinaryFileAtomic: vi.fn(),
  writeWorkspaceTextFileAtomic: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({ fs: fsMocks }),
}));

import {
  buildImportSetManifest,
  parseImportSetManifest,
  prepareImportSetSource,
  persistImportSet,
  serializeImportSetManifest,
  writeImportSet,
} from './import-set';

function plan(over: Partial<LimsImportPlan> = {}): LimsImportPlan {
  return {
    id: 'wizard-session-random',
    sourceName: 'orders.xlsx',
    sourceKind: 'xlsx',
    detectedKind: 'primer_table',
    columns: [
      {
        sourceColumn: 'Sequence',
        mappedField: 'fields.sequence',
        mappingMode: 'mapped',
        confidence: 'user_overridden',
        warnings: [],
      },
    ],
    records: [],
    aggregateWarnings: [],
    forcedKind: 'oligo',
    canApply: true,
    oracle: { ok: true, source: 'orders.xlsx', invariants: [] },
    selectedSheet: 'Oligos',
    ...over,
  };
}

describe('presentation-neutral import-set artifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.exists.mockResolvedValue(false);
    fsMocks.readFile.mockResolvedValue(new Uint8Array());
    fsMocks.readTextFile.mockResolvedValue('');
    fsMocks.sha256File.mockResolvedValue(`sha256:${'a'.repeat(64)}`);
    fsMocks.writeWorkspaceBinaryFileAtomic.mockResolvedValue({
      path: '/workspace/.waypoint/import-sets/source.xlsx',
      contentHash: `sha256:${'a'.repeat(64)}`,
    });
    fsMocks.writeWorkspaceTextFileAtomic.mockResolvedValue({
      path: '/workspace/.waypoint/import-sets/manifest.json',
      contentHash: `sha256:${'b'.repeat(64)}`,
    });
  });

  it('derives stable import-set identity from the source, not the wizard session or row order', async () => {
    const source = await prepareImportSetSource({
      plan: plan(),
      text: 'Name,Sequence\nA,ACGT',
    });
    const first = await buildImportSetManifest({
      plan: plan(),
      workspaceRoot: '/workspace',
      destinationDir: '/workspace/orders',
      source,
      partitions: [{ plan: plan(), members: [] }],
      now: '2026-08-20T12:00:00.000Z',
    });
    const second = await buildImportSetManifest({
      plan: plan({ id: 'different-session' }),
      workspaceRoot: '/workspace',
      destinationDir: '/workspace/orders',
      source,
      partitions: [{ plan: plan({ id: 'different-session' }), members: [] }],
      now: '2026-08-20T13:00:00.000Z',
    });

    expect(first.id).toBe(second.id);
    expect(first.destinationRelativePath).toBe('orders');
    expect(first.source).toMatchObject({
      type: 'file',
      name: 'orders.xlsx',
      kind: 'xlsx',
    });
    expect(first.partitions[0]).toMatchObject({ sourcePartition: 'Oligos' });
    expect(first).not.toHaveProperty('presentation');
  });

  it('round-trips a strict versioned manifest and rejects unknown future versions', async () => {
    const source = await prepareImportSetSource({ plan: plan(), text: 'A,B\n1,2' });
    const manifest = await buildImportSetManifest({
      plan: plan(),
      workspaceRoot: '/workspace',
      destinationDir: '/workspace',
      source,
      partitions: [
        {
          plan: plan(),
          members: [
            {
              sourceRecordId: 'row-2',
              sourceRowId: 'rowid-deadbeef',
              sourceRow: 2,
              entityId: 'primer-1',
              entityKind: 'oligo',
              artifactRelativePath: 'orders/A.primer.json',
            },
          ],
        },
      ],
      now: '2026-08-20T12:00:00.000Z',
    });

    expect(parseImportSetManifest(serializeImportSetManifest(manifest))).toEqual(manifest);
    expect(() => parseImportSetManifest(JSON.stringify({ ...manifest, schemaVersion: 2 }))).toThrow(
      /newer|unsupported/i
    );
  });

  it('keeps one workbook-level set with separate mapping partitions for each worksheet', async () => {
    const source = await prepareImportSetSource({ plan: plan(), text: 'workbook bytes' });
    const manifest = await buildImportSetManifest({
      workspaceRoot: '/workspace',
      destinationDir: '/workspace/orders',
      source,
      partitions: [
        { plan: plan({ selectedSheet: 'DNA' }), members: [] },
        { plan: plan({ selectedSheet: 'RNA', forcedKind: 'rna_oligo' }), members: [] },
      ],
      now: '2026-08-20T12:00:00.000Z',
    });

    expect(manifest.partitions).toHaveLength(2);
    expect(manifest.partitions.map((partition) => partition.sourcePartition)).toEqual([
      'DNA',
      'RNA',
    ]);
    expect(manifest.source).not.toHaveProperty('selectedSheet');
  });

  it('records an uploaded protein .faa as a file source with retained bytes', async () => {
    const source = await prepareImportSetSource({
      plan: plan({ sourceName: 'ordered-proteins.faa', sourceKind: 'fasta' }),
      text: '>Protein A\nMKKIGYSAR\n',
    });

    expect(source.descriptor).toMatchObject({
      type: 'file',
      name: 'ordered-proteins.faa',
      kind: 'fasta',
    });
    expect(ArrayBuffer.isView(source.snapshotBytes)).toBe(true);
  });

  it('keeps connector identity stable across source revisions for future sheet syncing', async () => {
    const firstSource = await prepareImportSetSource({
      plan: plan(),
      connector: {
        connectorType: 'google-sheets',
        connectionId: 'connection-1',
        externalDocumentId: 'sheet-123',
        revisionToken: 'revision-1',
      },
    });
    const secondSource = await prepareImportSetSource({
      plan: plan(),
      connector: {
        connectorType: 'google-sheets',
        connectionId: 'connection-1',
        externalDocumentId: 'sheet-123',
        revisionToken: 'revision-2',
      },
    });
    const build = (source: typeof firstSource) =>
      buildImportSetManifest({
        workspaceRoot: '/workspace',
        destinationDir: '/workspace/orders',
        source,
        partitions: [{ plan: plan(), members: [] }],
        now: '2026-08-20T12:00:00.000Z',
      });

    const [first, second] = await Promise.all([build(firstSource), build(secondSource)]);
    expect(first.id).toBe(second.id);
    expect(first.source.revisionToken).toBe('revision-1');
    expect(second.source.revisionToken).toBe('revision-2');
  });

  it('writes source bytes and the manifest through workspace-bounded atomic writers', async () => {
    const source = await prepareImportSetSource({ plan: plan(), text: 'A,B\n1,2' });
    const manifest = await buildImportSetManifest({
      plan: plan(),
      workspaceRoot: '/workspace',
      destinationDir: '/workspace/orders',
      source,
      partitions: [{ plan: plan(), members: [] }],
      now: '2026-08-20T12:00:00.000Z',
    });

    const result = await writeImportSet({ workspaceRoot: '/workspace', manifest, source });

    expect(fsMocks.writeWorkspaceBinaryFileAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: '/workspace',
        path: expect.stringContaining('/.waypoint/import-sets/'),
        content: expect.anything(),
        artifactNoun: 'import source snapshot',
      })
    );
    expect(
      ArrayBuffer.isView(fsMocks.writeWorkspaceBinaryFileAtomic.mock.calls[0]?.[0]?.content)
    ).toBe(true);
    expect(fsMocks.writeWorkspaceTextFileAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: '/workspace',
        path: expect.stringMatching(/\/manifest\.json$/),
        mode: 'create',
        artifactNoun: 'import-set manifest',
      })
    );
    expect(result.relativePaths).toContain(manifest.manifestRelativePath);
    expect(result.relativePaths).toContain(manifest.source.snapshotRelativePath);
  });

  it('persists generic protein partitions without adding a Files presentation field', async () => {
    const proteinPlan = plan({ forcedKind: 'protein', selectedSheet: 'Proteins' });
    const persisted = await persistImportSet({
      workspaceRoot: '/workspace',
      destinationDir: '/workspace/imports',
      source: { text: 'Name,Sequence\nGFP,MSK' },
      partitions: [
        {
          plan: proteinPlan,
          members: [
            {
              sourceRecordId: 'protein-row-1',
              sourceRowId: 'rowid-protein-1',
              sourceRow: 1,
              entityId: 'protein-1',
              entityKind: 'protein',
              artifactRelativePath: 'imports/records/protein/GFP.entity.json',
            },
          ],
        },
      ],
    });

    const manifestWrite = fsMocks.writeWorkspaceTextFileAtomic.mock.calls.find((call) =>
      String(call[0].path).endsWith('/manifest.json')
    )?.[0];
    expect(manifestWrite).toBeDefined();
    expect(JSON.parse(String(manifestWrite?.content))).not.toHaveProperty('presentation');
    expect(persisted.importSet.id).toMatch(/^import-set-/);
  });
});
