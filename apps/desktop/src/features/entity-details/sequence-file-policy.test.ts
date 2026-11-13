import { describe, expect, it } from 'vitest';
import { HARD_CAP_BYTES } from '../../shared/oversized-guard';
import { PARSER_DISPATCH_LIMITS } from '@waypoint/sequence-utils';
import { sequenceFileMetadataReadOnlyReason } from './sequence-file-policy';

describe('native sequence metadata access', () => {
  it('admits supported small GenBank files for the existing genetic-code writer', () => {
    for (const path of ['source.gb', 'source.GBK', 'source.gbff', 'source.genbank'])
      expect(sequenceFileMetadataReadOnlyReason(path, 1024)).toBeUndefined();
  });
  it('refuses unsupported or indexed sources before a metadata read can materialize their bytes', () => {
    for (const path of ['source.fa', 'source.fasta', 'source.dna', 'source.txt'])
      expect(sequenceFileMetadataReadOnlyReason(path, 1024)).toContain('read-only');
    expect(sequenceFileMetadataReadOnlyReason('chromosome.gb', HARD_CAP_BYTES + 1)).toContain(
      'read-only'
    );
    expect(
      sequenceFileMetadataReadOnlyReason(
        'chromosome.gb',
        PARSER_DISPATCH_LIMITS.genbankIndexedBytes
      )
    ).toContain('read-only');
  });
});
