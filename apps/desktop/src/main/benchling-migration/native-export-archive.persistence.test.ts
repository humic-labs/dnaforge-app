import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import yauzl, { type Options, type ZipFile } from 'yauzl';

import { buildSyntheticNativeExportZip } from './__fixtures__/native-export-zip-fixture';
import { ContentArchive } from './content-archive';
import {
  inspectNativeExportArchive,
  persistNativeExportArchiveEntries,
} from './native-export-archive';

describe('native export archive persistence', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('bounds concurrent durable writes and keeps deterministic receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-export-persistence-'));
    roots.push(root);
    const fixture = buildSyntheticNativeExportZip(
      Array.from({ length: 7 }, (_, index) => ({
        path: `records/object-${index}.txt`,
        bytes: `record ${index}`,
      }))
    );
    const localPath = join(root, 'export.zip');
    await writeFile(localPath, Buffer.from(fixture.bytes));
    const inspected = await inspectNativeExportArchive({
      kind: 'local_path',
      logicalFilename: 'export.zip',
      localPath,
      expectedSha256: fixture.sha256,
      expectedSizeBytes: fixture.sizeBytes,
    });

    class DelayedContentArchive extends ContentArchive {
      activeWrites = 0;
      peakWrites = 0;

      override async putStream(...args: Parameters<ContentArchive['putStream']>) {
        this.activeWrites += 1;
        this.peakWrites = Math.max(this.peakWrites, this.activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 20));
        try {
          return await super.putStream(...args);
        } finally {
          this.activeWrites -= 1;
        }
      }
    }

    const archive = new DelayedContentArchive(join(root, 'archive'));
    const persisted = await persistNativeExportArchiveEntries(
      inspected,
      inspected.entries.map((entry) => ({ entryPath: entry.path })),
      archive,
      { maxConcurrentWrites: 3 }
    );

    expect(archive.peakWrites).toBe(3);
    expect(persisted.map((entry) => entry.evidence.path)).toEqual(
      inspected.entries.map((entry) => entry.path)
    );
  });

  it('waits for in-flight writes before rejecting a concurrent failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-export-persistence-failure-'));
    roots.push(root);
    const fixture = buildSyntheticNativeExportZip(
      Array.from({ length: 5 }, (_, index) => ({
        path: `records/failure-${index}.txt`,
        bytes: `record ${index}`,
      }))
    );
    const localPath = join(root, 'export.zip');
    await writeFile(localPath, Buffer.from(fixture.bytes));
    const inspected = await inspectNativeExportArchive({
      kind: 'local_path',
      logicalFilename: 'export.zip',
      localPath,
      expectedSha256: fixture.sha256,
      expectedSizeBytes: fixture.sizeBytes,
    });

    class FailingContentArchive extends ContentArchive {
      activeWrites = 0;
      startedWrites = 0;

      override async putStream(...args: Parameters<ContentArchive['putStream']>) {
        this.activeWrites += 1;
        this.startedWrites += 1;
        const shouldFail = this.startedWrites === 2;
        try {
          const receipt = await super.putStream(...args);
          if (shouldFail) throw new Error('durable write failed');
          return receipt;
        } finally {
          this.activeWrites -= 1;
        }
      }
    }

    const archive = new FailingContentArchive(join(root, 'archive'));
    await expect(
      persistNativeExportArchiveEntries(
        inspected,
        inspected.entries.map((entry) => ({ entryPath: entry.path })),
        archive,
        { maxConcurrentWrites: 3 }
      )
    ).rejects.toThrow('durable write failed');
    expect(archive.activeWrites).toBe(0);
  });

  it('keeps the archive open until a pending metadata read settles after a write failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-export-pending-read-'));
    roots.push(root);
    const fixture = buildSyntheticNativeExportZip(
      Array.from({ length: 5 }, (_, index) => ({
        path: `records/pending-${index}.txt`,
        bytes: `record ${index}`,
      }))
    );
    const localPath = join(root, 'export.zip');
    await writeFile(localPath, Buffer.from(fixture.bytes));
    const inspected = await inspectNativeExportArchive({
      kind: 'local_path',
      logicalFilename: 'export.zip',
      localPath,
      expectedSha256: fixture.sha256,
      expectedSizeBytes: fixture.sizeBytes,
    });
    let releaseWrites!: () => void;
    let releaseFirstWrite!: () => void;
    let batchWritten!: () => void;
    let metadataReadStarted!: () => void;
    const writesGate = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const firstBatch = new Promise<void>((resolve) => {
      batchWritten = resolve;
    });
    const metadataRead = new Promise<void>((resolve) => {
      metadataReadStarted = resolve;
    });
    let zip: ZipFile | undefined;
    let resumeMetadataRead: (() => void) | undefined;
    let openedArchives = 0;
    const actualOpen = yauzl.open;
    type OpenCallback = (error: Error | null, file: ZipFile) => void;
    const open = vi
      .spyOn(yauzl, 'open')
      .mockImplementation(
        (path: string, optionsOrCallback?: Options | OpenCallback, callback?: OpenCallback) => {
          const completion = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
          const wrapped: OpenCallback = (error, file) => {
            if (!error && ++openedArchives === 2) {
              zip = file;
              const readEntry = file.readEntry.bind(file);
              let reads = 0;
              file.readEntry = () => {
                reads += 1;
                if (reads === 4) {
                  resumeMetadataRead = readEntry;
                  metadataReadStarted();
                } else readEntry();
              };
            }
            completion?.(error, file);
          };
          if (typeof optionsOrCallback === 'function') actualOpen(path, wrapped);
          else actualOpen(path, optionsOrCallback ?? {}, wrapped);
        }
      );
    class GatedContentArchive extends ContentArchive {
      startedWrites = 0;
      completedWrites = 0;
      override async putStream(...args: Parameters<ContentArchive['putStream']>) {
        const writeNumber = ++this.startedWrites;
        const receipt = await super.putStream(...args);
        if (++this.completedWrites === 3) batchWritten();
        await (writeNumber === 1 ? firstWriteGate : writesGate);
        if (writeNumber === 2) throw new Error('durable write failed');
        return receipt;
      }
    }
    const archive = new GatedContentArchive(join(root, 'archive'));
    let settled = false;
    const result = persistNativeExportArchiveEntries(
      inspected,
      inspected.entries.map((entry) => ({ entryPath: entry.path })),
      archive,
      { maxConcurrentWrites: 3 }
    ).then(
      () => {
        settled = true;
        return { error: null };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      }
    );
    try {
      await firstBatch;
      releaseFirstWrite();
      await metadataRead;
      releaseWrites();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(zip?.isOpen).toBe(true);
      const resume = resumeMetadataRead;
      resumeMetadataRead = undefined;
      resume?.();
      expect((await result).error).toMatchObject({ message: 'durable write failed' });
      expect(archive.startedWrites).toBe(3);
    } finally {
      releaseFirstWrite();
      releaseWrites();
      if (zip?.isOpen) resumeMetadataRead?.();
      await result;
      open.mockRestore();
    }
  });
});
