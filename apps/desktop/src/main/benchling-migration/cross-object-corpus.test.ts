import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTROLLED_CORPUS_GROUND_TRUTH,
  buildControlledCrossObjectCorpus,
} from './__fixtures__/cross-object-corpus';
import { decodeBenchlingNativeExport } from './native-export-decoder';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function basesOf(content: unknown): unknown {
  return content && typeof content === 'object' && 'bases' in content
    ? (content as { bases: unknown }).bases
    : null;
}

describe(' cross-object migration corpus', () => {
  it('builds deterministic import-order and identifier-loss variants', () => {
    const first = buildControlledCrossObjectCorpus();
    const second = buildControlledCrossObjectCorpus();

    expect(Object.keys(first)).toEqual([
      'complete',
      'notebooksFirst',
      'sequencesFirst',
      'idStripped',
    ]);
    expect(second).toEqual(first);
    expect(new Set(Object.values(first).map((fixture) => fixture.sha256)).size).toBe(4);
  });

  it('pins exact positive edges and the deliberately ambiguous negative twin', () => {
    expect(CONTROLLED_CORPUS_GROUND_TRUTH.relationships).toEqual([
      expect.objectContaining({
        sourceId: 'etr_DNA2347A',
        targetId: 'etr_DNA2347B',
        expectedResolution: 'exact',
      }),
      expect.objectContaining({
        sourceId: 'etr_DNA2347A',
        targetId: 'seq_DNA2347TARGET',
        expectedResolution: 'exact',
      }),
    ]);
    expect(CONTROLLED_CORPUS_GROUND_TRUTH.forbiddenMatches).toContainEqual({
      sourceId: 'etr_DNA2347A',
      targetId: 'seq_DNA2347TWIN',
      reason: 'Same display name and sequence bytes are not an identity key.',
    });
    expect(CONTROLLED_CORPUS_GROUND_TRUTH.importOrders).toEqual({
      notebooksFirst: {
        beforeSequenceImport: 'unresolved_with_missing_source_indicator',
        afterSequenceImport: 'exact_target_repaired',
      },
      sequencesFirst: {
        beforeNotebookImport: 'target_available',
        afterNotebookImport: 'exact_target_linked',
      },
      idStripped: 'unresolved_review_required',
    });
  });

  it('decodes the complete fixture with stable IDs as the only safe disambiguator', async () => {
    const fixture = buildControlledCrossObjectCorpus().complete;
    const root = await mkdtemp(join(tmpdir(), 'cross-object-corpus-'));
    roots.push(root);
    const zipPath = join(root, 'controlled-corpus.zip');
    await writeFile(zipPath, fixture.bytes);

    const decoded = await decodeBenchlingNativeExport({
      source: {
        kind: 'local_path',
        logicalFilename: 'controlled-corpus.zip',
        localPath: zipPath,
        expectedSha256: fixture.sha256,
        expectedSizeBytes: fixture.sizeBytes,
        duplicateSupportEntryPolicy: 'identical_root_benchling_css',
      },
      controlMetadata: { source: 'none' },
      context: {
        snapshotId: 'controlled-corpus',
        capturedAt: '2026-08-19T00:00:00.000Z',
        archivePartId: 'local-export:controlled-corpus',
        sourceUrlPrefix: null,
        localBundleAuthority: {
          schema: 'dnaforge.benchling.local-native-export-authority.v1',
          logicalFilename: 'controlled-corpus.zip',
          sha256: fixture.sha256,
        },
      },
    });

    const source = decoded.sourceObjects.find(({ stableId }) => stableId === 'etr_DNA2347A');
    const target = decoded.sourceObjects.find(({ stableId }) => stableId === 'seq_DNA2347TARGET');
    const twin = decoded.sourceObjects.find(({ stableId }) => stableId === 'seq_DNA2347TWIN');

    expect(source?.relationships.map(({ targetSourceId }) => targetSourceId).sort()).toEqual([
      'etr_DNA2347B',
      'seq_DNA2347TARGET',
    ]);
    expect(source?.relationships).not.toContainEqual(
      expect.objectContaining({ targetSourceId: 'seq_DNA2347TWIN' })
    );
    expect(target).toMatchObject({
      name: 'Duplicate display name',
      content: { bases: expect.any(String) },
    });
    expect(twin).toMatchObject({
      name: target?.name,
      content: {
        bases: basesOf(target?.content),
      },
    });
    expect(target?.stableId).not.toBe(twin?.stableId);
  });
});
