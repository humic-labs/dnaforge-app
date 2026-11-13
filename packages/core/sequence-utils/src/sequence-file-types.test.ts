import { describe, expect, it } from 'vitest';
import { sequenceFileTypeForPath } from './sequence-file-types';

describe('sequence filename contract', () => {
  it.each(['sample.dna', '/data/sample.DNA', 'C:\\data\\sample.DNA'])(
    'recognizes SnapGene at the actual path boundary: %s',
    (path) => {
      expect(sequenceFileTypeForPath(path)?.managedImport).toBe('snapgene');
    }
  );
  it.each(['dna', '.dna', 'sample.', '/path.dna/readme'])(
    'does not invent an extension from a stem or parent: %s',
    (path) => {
      expect(sequenceFileTypeForPath(path)).toBeNull();
    }
  );
});
