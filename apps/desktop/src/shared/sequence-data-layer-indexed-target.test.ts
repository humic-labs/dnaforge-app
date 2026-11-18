import { describe, expect, it } from 'vitest';
import {
  parseSequenceDataLayerIndexedTargetId,
  sequenceDataLayerIndexedTargetId,
} from './sequence-data-layer-indexed-target';

const identity = { sequenceIdentity: 'a'.repeat(64), annotationIdentity: 'b'.repeat(64) };

describe('indexed sequence data layer target identity', () => {
  it('round trips reference and chromosome names without aliasing encoded separators', () => {
    const target = { referenceId: 'ecoli:MG1655/reference%', chrom: 'NC_000913.3:α', ...identity };
    const id = sequenceDataLayerIndexedTargetId(target);
    expect(id).toBe(
      `indexed-reference:ecoli%3AMG1655%2Freference%25:NC_000913.3%3A%CE%B1:${identity.sequenceIdentity}:${identity.annotationIdentity}`
    );
    expect(parseSequenceDataLayerIndexedTargetId(id)).toEqual(target);
  });

  it('leaves ordinary document identifiers to the document owner', () => {
    expect(
      parseSequenceDataLayerIndexedTargetId('889f9752-21c5-4d3b-9401-84c28d4aa7db')
    ).toBeNull();
  });

  it.each([
    'indexed-reference',
    'indexed-reference-other',
    'indexed-reference:',
    'indexed-reference:ecoli:',
    'indexed-reference::NC_000913.3',
    'indexed-reference:ecoli:NC_000913.3:extra',
    'indexed-reference:%xx:NC_000913.3',
    'indexed-reference:%65coli:NC_000913.3',
    'indexed-reference:ecoli%2fmg:NC_000913.3',
    'indexed-reference:ecoli:%00',
    'indexed-reference:ecoli:%20',
    `indexed-reference:${'e'.repeat(500)}:NC_000913.3`,
  ])('rejects a malformed or noncanonical reserved target: %s', (id) => {
    expect(() => parseSequenceDataLayerIndexedTargetId(id)).toThrow();
  });

  it.each(['c'.repeat(63), 'C'.repeat(64), 'not-a-digest'])(
    'refuses invalid content identities: %s',
    (sequenceIdentity) => {
      expect(() =>
        sequenceDataLayerIndexedTargetId({
          referenceId: 'ecoli',
          chrom: 'chr',
          ...identity,
          sequenceIdentity,
        })
      ).toThrow();
    }
  );

  it('refuses identities exceeding the shared target identifier limit', () => {
    expect(() =>
      sequenceDataLayerIndexedTargetId({ referenceId: 'e'.repeat(500), chrom: 'chr1', ...identity })
    ).toThrow();
  });
});
