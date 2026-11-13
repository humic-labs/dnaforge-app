import { reverseComplement } from '@waypoint/sequence-utils/iupac';

import type { SourceId } from '../ids';
import type { PromoterBox, PromoterRecord, TranscriptionStartSiteRecord } from '../records';
import type { AnnotationSourceDefinition, SequenceReader } from '../sources';

const MINUS10_CONSENSUS = 'TATAAT';
const MINUS10_STARTS = [-12, -13, -11, -14, -10] as const;
const MINUS10_MIN_MATCHES = 5;

export function promoterWindowForStartSite(input: {
  readonly tss: TranscriptionStartSiteRecord;
  readonly sequence: SequenceReader;
  readonly upstreamBp: number;
  readonly idPrefix: string;
}): PromoterRecord {
  const { tss, sequence, upstreamBp } = input;
  const t = tss.location.bp;
  const forward = tss.strand === '+';
  const start = forward ? Math.max(0, t - upstreamBp) : t;
  const end = forward ? t + 1 : Math.min(sequence.lengthBp, t + upstreamBp + 1);
  const box = findMinus10Box({ t, forward, sequence });
  return {
    id: `${input.idPrefix}:${tss.id}`,
    kind: 'promoter',
    strand: tss.strand,
    location: { shape: 'region', start, end },
    transcriptionStartBp: t,
    boxes: box ? [box] : [],
    sigmaFactor: null,
    name: tss.name,
    score: tss.score,
    conditions: tss.conditions,
  };
}

function findMinus10Box(input: {
  t: number;
  forward: boolean;
  sequence: SequenceReader;
}): PromoterBox | null {
  const { t, forward, sequence } = input;
  let best: { start: number; matches: number } | null = null;
  for (const relative of MINUS10_STARTS) {
    const upstream = -relative;
    const boxStart = forward ? t - upstream : t + upstream - 5;
    const boxEnd = boxStart + 6;
    if (boxStart < 0 || boxEnd > sequence.lengthBp) continue;
    const bases = sequence.slice(boxStart, boxEnd);
    const transcribed = forward ? bases : reverseComplement(bases);
    const matches = countMatches(transcribed, MINUS10_CONSENSUS);
    if (!best || matches > best.matches) best = { start: boxStart, matches };
  }
  return best && best.matches >= MINUS10_MIN_MATCHES
    ? { element: 'minus10', start: best.start, end: best.start + 6 }
    : null;
}

function countMatches(a: string, b: string): number {
  let matches = 0;
  for (let i = 0; i < b.length; i += 1) if (a[i] === b[i]) matches += 1;
  return matches;
}

export function promoterWindowsFromStartSitesSource(input: {
  readonly id: SourceId;
  readonly upstream: AnnotationSourceDefinition;
  readonly upstreamBp: number;
}): AnnotationSourceDefinition {
  const { upstream } = input;
  if (!upstream.kinds.includes('tss')) {
    throw new Error(`${upstream.label} provides no start sites to derive promoters from`);
  }
  return {
    id: input.id,
    label: `Promoter windows from ${upstream.label}`,
    kinds: ['promoter'],
    assembly: upstream.assembly,
    evidence: 'computed',
    derivedFrom: [upstream.id],
    availability: upstream.availability,
    provenance: {
      ...upstream.provenance,
      datasetVersion: `${input.upstreamBp} bp upstream of each start site, −10 hexamer start searched from −14 to −10, so a called box can span up to −5 (at least ${MINUS10_MIN_MATCHES} of 6 bases matching ${MINUS10_CONSENSUS}); start sites from ${upstream.provenance.datasetVersion}`,
      license: {
        ...upstream.provenance.license,
        attribution: `${upstream.provenance.license.attribution} Promoter windows derived by DNAForge.`,
      },
    },
    load: async (context) => {
      const records = await context.loadRecords(upstream.id);
      const promoters: PromoterRecord[] = [];
      for (const record of records) {
        if (record.kind !== 'tss') continue;
        promoters.push(
          promoterWindowForStartSite({
            tss: record,
            sequence: context.sequence,
            upstreamBp: input.upstreamBp,
            idPrefix: input.id,
          })
        );
      }
      return promoters;
    },
  };
}
