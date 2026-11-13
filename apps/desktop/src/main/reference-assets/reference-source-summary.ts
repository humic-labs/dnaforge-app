import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';

import type { IndexedGenomeManifest } from '@waypoint/genome-data';
import { LocalIndexedGenomeDataSource } from '@waypoint/genome-data/node';

import { getOrCreateAnnotationOverviewTile } from '../ipc/genome-overview-tile-cache';

export interface ChromosomeSourceSummaryJobV1 {
  readonly manifest: IndexedGenomeManifest;
  readonly chrom: string;
  readonly length: number;
  readonly sourceBuildFingerprint: string;
}

export async function ensureChromosomeSourceSummaryV1(
  job: ChromosomeSourceSummaryJobV1
): Promise<void> {
  const source = new LocalIndexedGenomeDataSource(job.manifest, {
    checkFileMtimeOnRead: false,
    featureCacheEntries: 1,
    sequenceCacheEntries: 1,
  });
  try {
    await getOrCreateAnnotationOverviewTile({
      manifest: job.manifest,
      request: {
        trackId: `${job.chrom}:annotations`,
        chrom: job.chrom,
        start: 0,
        end: job.length,
        lod: 0,
        generation: 0,
        fidelity: 'summary',
      },
      loadRawFeatures: () => source.getFeatures(job.chrom, 0, job.length, 0),
      deps: {
        mkdir,
        realpath,
        stat,
        readFile: (path) => readFile(path, 'utf8'),
        writeFile: (path, content) => writeFile(path, content, 'utf8'),
        rename,
        unlink,
        sourceBuildFingerprint: job.sourceBuildFingerprint,
      },
    });
  } finally {
    await source.close();
  }
}
