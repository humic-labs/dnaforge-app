import { describe, expect, it } from 'vitest';
import { getCDSIntrons, translateCDS } from './translation';

describe('circular spliced CDSs through a windowed base reader', () => {
  const sequence = 'N'.repeat(603);
  const reader = (bp: number) => sequence[bp];
  const options = {
    segments: [
      { start: 451, end: 558 },
      { start: 101, end: 250 },
    ],
  };

  for (const direction of ['forward', 'reverse'] as const) {
    it(`${direction} intron lengths and splice sites match the full sequence`, () => {
      const expected = getCDSIntrons(sequence, 450, 250, direction, options);
      const actual = getCDSIntrons(reader, 450, 250, direction, options, sequence.length);
      expect(actual).toEqual(expected);
      expect(actual).toMatchObject([{ genomicStart: 558, genomicEnd: 99, length: 145 }]);
    });

    it(`${direction} codon positions and fragments match the full sequence`, () => {
      expect(translateCDS(reader, 450, 250, direction, sequence.length, true, options)).toEqual(
        translateCDS(sequence, 450, 250, direction, sequence.length, true, options)
      );
    });

    it(`${direction} exons crossing the origin stay inside the real genome`, () => {
      const originExon = {
        segments: [
          { start: 451, end: 50 },
          { start: 101, end: 250 },
        ],
        qualifiers: { codon_start: '2' },
      };
      const boundedReader = (bp: number) => {
        if (bp < 0 || bp >= sequence.length) throw Error(`Base outside genome: ${bp}`);
        return sequence[bp];
      };
      expect(
        getCDSIntrons(boundedReader, 450, 250, direction, originExon, sequence.length)
      ).toEqual(getCDSIntrons(sequence, 450, 250, direction, originExon));
      expect(
        translateCDS(boundedReader, 450, 250, direction, sequence.length, true, originExon)
      ).toEqual(translateCDS(sequence, 450, 250, direction, sequence.length, true, originExon));
    });
  }

  it('requires the actual length for an origin-spanning reader instead of inventing an intron', () => {
    expect(() => getCDSIntrons(reader, 450, 250, 'forward', options)).toThrow(/genome length/i);
  });

  it('retains the length-free reader contract for linear splices', () => {
    const linear = {
      segments: [
        { start: 101, end: 200 },
        { start: 301, end: 400 },
      ],
    };
    expect(getCDSIntrons(reader, 100, 400, 'forward', linear)).toEqual(
      getCDSIntrons(sequence, 100, 400, 'forward', linear)
    );
  });
});
