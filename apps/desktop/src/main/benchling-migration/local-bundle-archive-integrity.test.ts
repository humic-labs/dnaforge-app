import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { expect, it, vi } from 'vitest';

import type { SourceObject, SourceSnapshot } from '../../shared/benchling-migration';
import { buildSyntheticNativeExportZip } from './__fixtures__/native-export-zip-fixture';
import { ContentArchive, type ContentArchiveManifest } from './content-archive';
import { migrationEvidenceId } from './evidence-id';
import * as externalZip from './external-zip-source';
import { verifyLocalSnapshotArchiveIntegrity } from './local-bundle-executor';

describe('local snapshot archive integrity', () => {
  it('hashes one immutable export blob once while checking every object association', async () => {
    const primaryHash = 'a'.repeat(64);
    const sharedSupplementHash = 'b'.repeat(64);
    const primaryPartId = 'part-primary';
    const supplementalPartIds = ['part-supplement-1', 'part-supplement-2'];
    const supplementalSourceIds = ['seq_supplement_1', 'seq_supplement_2'];
    const primaryManifestId = 'manifest-primary';
    const manifests = new Map<string, ContentArchiveManifest>([
      [
        primaryManifestId,
        {
          version: 1,
          entries: [
            {
              logicalFilename: 'primary.zip',
              sourceArchivePath: 'primary.zip',
              sha256: primaryHash,
              size: 100,
              archivePartId: primaryPartId,
              sourceObjectId: null,
            },
          ],
        },
      ],
      ...supplementalPartIds.map(
        (partId, index) =>
          [
            migrationEvidenceId('supplemental', partId),
            {
              version: 1 as const,
              entries: [
                {
                  logicalFilename: 'shared-export.zip',
                  sourceArchivePath: `supplementary/${index}/shared-export.zip`,
                  sha256: sharedSupplementHash,
                  size: 200,
                  archivePartId: partId,
                  sourceObjectId: supplementalSourceIds[index],
                },
              ],
            },
          ] as const
      ),
    ]);
    const readManifest = vi.fn(async (manifestId: string) => {
      const manifest = manifests.get(manifestId);
      if (!manifest) throw new Error(`Missing test manifest ${manifestId}`);
      return manifest;
    });
    const verifyBlob = vi.fn(async () => undefined);
    const archive = { readManifest, verifyBlob } as unknown as ContentArchive;
    const snapshot: SourceSnapshot = {
      version: 1,
      id: 'snapshot-1',
      runId: 'run-1',
      accountHash: 'account-hash',
      createdAt: '2026-08-24T20:00:00.000Z',
      archiveManifestId: primaryManifestId,
      initialSourceObjectIds: [...supplementalSourceIds].sort(),
      expectedSourceObjectCount: 2,
      expectedAttachmentCount: 0,
      expectedMembershipCount: 0,
      parts: [
        {
          id: primaryPartId,
          kind: 'local_export',
          sha256: primaryHash,
          sizeBytes: 100,
          capturedAt: '2026-08-24T20:00:00.000Z',
          sourceJobId: null,
          sourceObjectId: null,
          supersedesPartId: null,
        },
        ...supplementalPartIds.map((partId, index) => ({
          id: partId,
          kind: 'supplemental_local_export' as const,
          sha256: sharedSupplementHash,
          sizeBytes: 200,
          capturedAt: `2026-08-24T20:00:0${index + 1}.000Z`,
          sourceJobId: null,
          sourceObjectId: supplementalSourceIds[index],
          supersedesPartId: null,
        })),
      ],
    };

    const result = await verifyLocalSnapshotArchiveIntegrity(snapshot, archive);

    expect(result.failures).toEqual([]);
    expect(result.evidence.snapshotParts).toHaveLength(3);
    expect(result.evidence.manifestEntries).toHaveLength(3);
    expect(readManifest).toHaveBeenCalledTimes(3);
    expect(verifyBlob.mock.calls).toEqual([
      [primaryHash, 100],
      [sharedSupplementHash, 200],
    ]);

    const verifyExternal = vi
      .spyOn(externalZip, 'verifyExternalZipSource')
      .mockResolvedValue('/source.zip');
    const supplemental = [
      {
        source: {
          schema: 'dnaforge.benchling.external-zip-source.v1' as const,
          sourceId: 'external-source',
          originalPath: '/source.zip',
          displayName: 'source.zip',
          zipSha256: `sha256:${sharedSupplementHash}` as const,
          sizeBytes: 200,
          selectedAt: '2026-08-24T20:00:00.000Z',
        },
        entries: [],
      },
    ];
    try {
      const externalResult = await verifyLocalSnapshotArchiveIntegrity(
        snapshot,
        archive,
        [],
        undefined,
        undefined,
        undefined,
        supplemental
      );
      expect(externalResult.failures).toEqual([]);
      expect(externalResult.evidence.snapshotParts).toHaveLength(3);
      expect(verifyExternal).toHaveBeenCalledTimes(1);
      verifyExternal.mockRejectedValue(new Error('Source is no longer available'));
      const nextBoundary = await verifyLocalSnapshotArchiveIntegrity(
        snapshot,
        archive,
        [],
        undefined,
        undefined,
        undefined,
        supplemental
      );
      expect(verifyExternal).toHaveBeenCalledTimes(2);
      expect(nextBoundary.failures.map((failure) => failure.evidenceId)).toEqual([
        'snapshot-part:part-supplement-1',
        'snapshot-part:part-supplement-2',
      ]);
    } finally {
      verifyExternal.mockRestore();
    }
  });

  it('persists and binds a supplemental ZIP raw entry to its verified container', async () => {
    const root = await mkdtemp(join(tmpdir(), 'benchling-archive-integrity-'));
    try {
      const archive = new ContentArchive(join(root, 'archive'));
      const rawPath = 'Registry/EMB19 (bfi_TEST).txt';
      const rawBytes = new TextEncoder().encode('Registry fallback evidence.');
      const rawSha256 = createHash('sha256').update(rawBytes).digest('hex');
      const fixture = buildSyntheticNativeExportZip([{ path: rawPath, bytes: rawBytes }]);
      const zipPath = join(root, 'supplemental.zip');
      await writeFile(zipPath, fixture.bytes);
      const zipBlob = await archive.putFile(zipPath, {
        expectedSha256: fixture.sha256,
        expectedSize: fixture.sizeBytes,
      });
      const partId = 'part-supplemental';
      const sourceObjectId = 'bfi_TEST';
      const rawArchivePartId = `supplemental-local-export:${zipBlob.sha256}`;
      const primaryManifestId = 'manifest-primary';
      await archive.writeManifest(primaryManifestId, { version: 1, entries: [] });
      await archive.writeManifest(migrationEvidenceId('supplemental', partId), {
        version: 1,
        entries: [
          {
            logicalFilename: basename(zipPath),
            sourceArchivePath: 'supplementary/bfi_TEST/supplemental.zip',
            sha256: zipBlob.sha256,
            size: zipBlob.size,
            archivePartId: partId,
            sourceObjectId,
          },
        ],
      });
      const snapshot: SourceSnapshot = {
        version: 1,
        id: 'snapshot-supplemental',
        runId: 'run-supplemental',
        accountHash: 'account-hash',
        createdAt: '2026-08-25T20:00:00.000Z',
        archiveManifestId: primaryManifestId,
        initialSourceObjectIds: [sourceObjectId],
        expectedSourceObjectCount: 1,
        expectedAttachmentCount: 0,
        expectedMembershipCount: 0,
        parts: [
          {
            id: partId,
            kind: 'supplemental_local_export',
            sha256: zipBlob.sha256,
            sizeBytes: zipBlob.size,
            capturedAt: '2026-08-25T20:00:00.000Z',
            sourceJobId: null,
            sourceObjectId,
            supersedesPartId: null,
          },
        ],
      };
      const sourceObject: SourceObject = {
        id: sourceObjectId,
        stableId: sourceObjectId,
        sourceType: 'unsupported_object',
        name: 'EMB19',
        aliases: [],
        sourceUrl: 'https://example.benchling.com/bfi_TEST',
        attachmentHashes: [],
        memberships: [],
        metadata: {},
        content: {
          sha256: `sha256:${rawSha256}`,
          sizeBytes: rawBytes.byteLength,
          rawAccess: { archivePartId: rawArchivePartId, entryPath: rawPath },
        },
        relationships: [],
      };

      const progress = vi.fn();
      const result = await verifyLocalSnapshotArchiveIntegrity(
        snapshot,
        archive,
        [sourceObject],
        progress
      );

      expect(result.failures).toEqual([]);
      expect(result.evidence.manifestEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            archivePartId: rawArchivePartId,
            containerPartId: partId,
            sourceObjectId,
            entryPath: rawPath,
            sha256: rawSha256,
            sizeBytes: rawBytes.byteLength,
            containerSha256: zipBlob.sha256,
            containerSizeBytes: zipBlob.size,
          }),
        ])
      );
      await expect(archive.verifyBlob(rawSha256, rawBytes.byteLength)).resolves.toEqual(
        expect.objectContaining({ sha256: rawSha256, size: rawBytes.byteLength })
      );
      expect(progress).toHaveBeenCalledWith({
        phase: 'persisting_source_files',
        completed: 1,
        total: 1,
      });
      expect(progress).toHaveBeenCalledWith({
        phase: 'validating_source_files',
        completed: 1,
        total: 1,
      });

      const putStream = vi.spyOn(archive, 'putStream');
      const retried = await verifyLocalSnapshotArchiveIntegrity(snapshot, archive, [sourceObject]);
      expect(retried.failures).toEqual([]);
      expect(putStream).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
