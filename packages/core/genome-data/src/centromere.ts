import type { AssemblySequenceRole } from './assembly-sequence-role';

export interface NormalizedCentromereInterval {
  readonly startBp: number;
  readonly endBp: number;
}

export interface UcscCytobandCentromereSource {
  readonly kind: 'ucsc-cytobands';
  readonly records: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly stain: string;
  }>;
}

export interface Gff3CentromereSource {
  readonly kind: 'gff3-features';
  readonly records: ReadonlyArray<{
    readonly type: string;
    readonly start: number;
    readonly end: number;
  }>;
}

export type CentromereAnnotationSource = UcscCytobandCentromereSource | Gff3CentromereSource;

export interface NormalizeChromosomeCentromereInput {
  readonly chromosomeLengthBp: number;
  readonly role: AssemblySequenceRole | undefined;
  readonly circular: boolean | undefined;
  readonly source: CentromereAnnotationSource | undefined;
}

export function normalizeChromosomeCentromere(
  input: NormalizeChromosomeCentromereInput
): NormalizedCentromereInterval | null {
  if (
    input.role !== 'assembled-molecule' ||
    input.circular === true ||
    !Number.isFinite(input.chromosomeLengthBp) ||
    input.chromosomeLengthBp <= 0 ||
    !input.source
  ) {
    return null;
  }

  const source = input.source as CentromereAnnotationSource & { readonly kind: string };
  let candidates: ReadonlyArray<NormalizedCentromereInterval>;
  if (source.kind === 'ucsc-cytobands') {
    candidates = source.records
      .filter((record) => record.stain === 'acen')
      .map((record) => ({ startBp: record.start, endBp: record.end }));
  } else if (source.kind === 'gff3-features') {
    candidates = source.records
      .filter((record) => record.type === 'centromere')
      .map((record) => ({ startBp: record.start - 1, endBp: record.end }));
  } else {
    return null;
  }

  if (candidates.length === 0) return null;
  const ordered = [...candidates].sort(
    (left, right) => left.startBp - right.startBp || left.endBp - right.endBp
  );
  if (ordered.some((record) => !validSourceInterval(record, input.chromosomeLengthBp))) {
    return null;
  }

  let startBp = ordered[0].startBp;
  let endBp = ordered[0].endBp;
  for (let index = 1; index < ordered.length; index += 1) {
    const record = ordered[index];
    if (record.startBp > endBp) return null;
    startBp = Math.min(startBp, record.startBp);
    endBp = Math.max(endBp, record.endBp);
  }

  return { startBp, endBp };
}

function validSourceInterval(
  interval: NormalizedCentromereInterval,
  chromosomeLengthBp: number
): boolean {
  return (
    Number.isFinite(interval.startBp) &&
    Number.isFinite(interval.endBp) &&
    interval.startBp > 0 &&
    interval.endBp < chromosomeLengthBp &&
    interval.endBp > interval.startBp
  );
}
