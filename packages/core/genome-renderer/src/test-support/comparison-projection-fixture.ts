import { createGenomeComparisonBlock } from '@waypoint/genome-data';
import { createComparisonProjection } from '../comparison-projection';

export function comparisonFixture() {
  return createComparisonProjection({
    id: 'exact-comparison',
    comparison: {
      target: { id: 'target', length: 20 },
      query: { id: 'query', length: 20 },
      blocks: [
        createGenomeComparisonBlock({
          id: 'forward',
          target: { referenceId: 'target', start: 0, end: 7 },
          query: { referenceId: 'query', start: 0, end: 8 },
          strand: '+',
          matchingBases: 6,
          alignmentColumns: 9,
          mappingQuality: 60,
          cigar: '2M2I2M1D2M',
        }),
        createGenomeComparisonBlock({
          id: 'reverse',
          target: { referenceId: 'target', start: 10, end: 13 },
          query: { referenceId: 'query', start: 10, end: 13 },
          strand: '-',
          matchingBases: 3,
          alignmentColumns: 3,
          mappingQuality: 20,
          cigar: '3M',
        }),
      ],
    },
    targetSequence: 'ACGTACGTACGTACGTACGT',
    querySequence: 'ACGTACGTACGTACGTACGT',
  });
}
