import { withUserMessage, userMessagePayload, userMessageValue } from '@waypoint/user-messages';
import { reverseComplement, translateCodon } from '@waypoint/sequence-utils';

export interface SaturationLibraryInput {
  reference: string;
  cdsStart: number;
  cdsEnd: number;
  strand: 'forward' | 'reverse';
  firstResidue: number;
  lastResidue: number;
  codon: 'NNK' | 'NNS';
  flankLength: number;
}

export interface SaturationPrimerPair {
  codingStrand: SaturationLibraryInput['strand'];
  residue: number;
  nativeCodon: string;
  nativeAminoAcid: string;
  templateStart: number;
  templateEnd: number;
  forward: string;
  reverse: string;
}

export function designSaturationLibrary(input: SaturationLibraryInput): SaturationPrimerPair[] {
  const { reference, cdsStart, cdsEnd, firstResidue, lastResidue, flankLength } = input;
  if (!/^[ACGT]+$/i.test(reference)) {
    throw withUserMessage(
      new Error('The template must contain only A, C, G and T. Resolve ambiguous bases first.'),
      'primer.saturationTemplate'
    );
  }
  if (![cdsStart, cdsEnd, firstResidue, lastResidue, flankLength].every(Number.isSafeInteger)) {
    throw withUserMessage(
      new Error('Coordinates, residue numbers and flank length must be whole numbers.'),
      'primer.saturationCoordinates'
    );
  }
  if (
    cdsStart < 0 ||
    cdsEnd > reference.length ||
    cdsEnd <= cdsStart ||
    (cdsEnd - cdsStart) % 3 !== 0
  ) {
    throw withUserMessage(
      new Error('Choose a CDS within the template whose length is a multiple of three.'),
      'primer.saturationCds'
    );
  }
  if (firstResidue < 1 || lastResidue < firstResidue || lastResidue > (cdsEnd - cdsStart) / 3) {
    throw withUserMessage(
      new Error('Choose a residue interval within the CDS, numbered from one.'),
      'primer.saturationResidues'
    );
  }
  if (lastResidue - firstResidue >= 10_000) {
    throw withUserMessage(
      new Error('Design at most 10,000 residues in one library.'),
      'primer.saturationLimit'
    );
  }
  if (flankLength < 15 || flankLength > 50) {
    throw withUserMessage(
      new Error('Choose 15 to 50 matching bases on each side of the degenerate codon.'),
      'primer.saturationFlanks'
    );
  }
  const sequence = reference.toUpperCase();
  const codingTemplate = input.strand === 'forward' ? sequence : reverseComplement(sequence);
  const codingStart = input.strand === 'forward' ? cdsStart : sequence.length - cdsEnd;
  const pairs: SaturationPrimerPair[] = [];
  for (let residue = firstResidue; residue <= lastResidue; residue += 1) {
    const codonStart = codingStart + (residue - 1) * 3;
    const start = codonStart - flankLength;
    const end = codonStart + 3 + flankLength;
    if (start < 0 || end > codingTemplate.length) {
      throw withUserMessage(
        new Error(
          `Residue ${residue} needs ${flankLength} template bases on both sides. Include flanking DNA or choose an internal residue.`
        ),
        userMessagePayload('primer.saturationMissingFlanks', {
          residue: userMessageValue(residue),
          flank: userMessageValue(flankLength),
        })
      );
    }
    const nativeCodon = codingTemplate.slice(codonStart, codonStart + 3);
    const nativeAminoAcid = translateCodon(nativeCodon);
    if (nativeAminoAcid === '*') {
      throw withUserMessage(
        new Error(
          `Position ${residue} is a stop codon. Select amino-acid residues without the terminal stop.`
        ),
        userMessagePayload('primer.saturationStop', { residue: userMessageValue(residue) })
      );
    }
    const forward =
      codingTemplate.slice(start, codonStart) +
      input.codon +
      codingTemplate.slice(codonStart + 3, end);
    pairs.push({
      codingStrand: input.strand,
      residue,
      nativeCodon,
      nativeAminoAcid,
      templateStart: input.strand === 'forward' ? start : sequence.length - end,
      templateEnd: input.strand === 'forward' ? end : sequence.length - start,
      forward,
      reverse: reverseComplement(forward),
    });
  }
  return pairs;
}

export function saturationLibraryTsv(pairs: SaturationPrimerPair[], codon: 'NNK' | 'NNS'): string {
  const header =
    'Name\tResidue\tNative codon\tNative amino acid\tTemplate start (1-based)\tTemplate end (inclusive)\tCoding strand\tSequence (5\u2032 to 3\u2032)';
  return [
    header,
    ...pairs.flatMap((pair) =>
      ['F', 'R'].map((direction) =>
        [
          `${pair.nativeAminoAcid}${pair.residue}_${codon}_${direction}`,
          pair.residue,
          pair.nativeCodon,
          pair.nativeAminoAcid,
          pair.templateStart + 1,
          pair.templateEnd,
          pair.codingStrand,
          direction === 'F' ? pair.forward : pair.reverse,
        ].join('\t')
      )
    ),
  ].join('\n');
}
