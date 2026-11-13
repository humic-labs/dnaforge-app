// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const preloadDir = resolve(__dirname);
const indexSource = readFileSync(resolve(preloadDir, 'index.ts'), 'utf8');
const indexedIpcSource = readFileSync(resolve(preloadDir, 'indexed-genome-ipc.ts'), 'utf8');

const INDEXED_GENOME_SEARCH_BRIDGES = [
  'searchSequence',
  'searchAssemblySequence',
  'cancelSequenceSearch',
] as const;

describe('indexed genome IPC extract', () => {
  it('owns the three indexed genome search bridges', () => {
    for (const bridge of INDEXED_GENOME_SEARCH_BRIDGES) {
      expect(indexedIpcSource).toContain(`${bridge}:`);
      expect(indexedIpcSource).toContain(`rendererIpc.invoke('genome:${bridge}'`);
    }
    expect(indexedIpcSource).toContain('export function createIndexedGenomeIpc');
  });

  it('leaves preload/index.ts as a re-export of the extracted genome object', () => {
    expect(indexSource).toContain("from './indexed-genome-ipc'");
    expect(indexSource).toContain('genome: createIndexedGenomeIpc()');
    for (const bridge of INDEXED_GENOME_SEARCH_BRIDGES) {
      expect(indexSource).not.toContain(`${bridge}:`);
      expect(indexSource).not.toContain(`rendererIpc.invoke('genome:${bridge}'`);
    }
  });
});
