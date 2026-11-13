import type { Feature } from './types';

export function annotationCodonCarrierSignature(feature: Feature): string | null {
  if (feature.direction === 'none') return null;
  const legacyCds = feature.type === 'CDS';
  const transcriptCds = Array.isArray(feature.cds) && feature.cds.length > 0;
  if (!legacyCds && !transcriptCds) return null;
  const spans = legacyCds ? feature.segments : feature.cds;
  const spanKey = (spans ?? []).map((span) => `${span.start}-${span.end}`).join(',');
  return [
    legacyCds ? 'legacy-cds' : 'transcript-cds',
    feature.start,
    feature.end,
    feature.direction,
    feature.qualifiers?.codon_start ?? '',
    spanKey,
  ].join('|');
}

export function isAnnotationCodonCarrier(feature: Feature): boolean {
  return annotationCodonCarrierSignature(feature) !== null;
}
