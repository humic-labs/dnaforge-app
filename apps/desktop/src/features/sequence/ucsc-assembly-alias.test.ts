// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { ucscTrackTargetForAssembly } from './ucsc-assembly-alias';

describe('ucscTrackTargetForAssembly', () => {
  it.each([
    ['grch38', 'hg38'],
    ['ce11', 'ce11'],
    ['sacCer3', 'sacCer3'],
    ['grcz12tu', 'GCF_049306965.2'],
  ])('maps canonical DNAForge assembly %s to UCSC genome %s', (assemblyId, ucscGenome) => {
    expect(ucscTrackTargetForAssembly(assemblyId)).toEqual({ genomeId: ucscGenome });
  });

  it.each(['custom', 'hg38', 'GRCh38', 'grch38.p14', 'SACCER3', ''])(
    'refuses unlisted or non-canonical assembly id %j',
    (assemblyId) => {
      expect(ucscTrackTargetForAssembly(assemblyId)).toBeNull();
    }
  );

  it('cannot be influenced by a misleading display name', () => {
    expect(ucscTrackTargetForAssembly('custom')).toBeNull();
  });
});
