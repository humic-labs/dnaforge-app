import { stat } from 'node:fs/promises';

import { IndexedGenomeDataSource } from './indexed-genome-data-source';
import type { IndexedGenomeManifest, LocalIndexedGenomeDataSourceOptions } from './types';

export { tabixReaderOptions } from './indexed-genome-data-source';

export class LocalIndexedGenomeDataSource extends IndexedGenomeDataSource {
  constructor(manifest: IndexedGenomeManifest, opts: LocalIndexedGenomeDataSourceOptions = {}) {
    super(manifest, {
      ...opts,
      checkFileMtimeOnRead: opts.checkFileMtimeOnRead ?? true,
      fingerprintFiles: fingerprintLocalFiles,
    });
  }
}

async function fingerprintLocalFiles(paths: readonly string[]): Promise<string> {
  const parts = await Promise.all(
    paths.map(async (p) => {
      const s = await stat(p);
      return `${p}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    })
  );
  return parts.join('|');
}
