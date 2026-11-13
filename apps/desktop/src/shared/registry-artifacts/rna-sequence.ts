import { computeChecksum } from '@waypoint/sequence-utils';
import type { RnaSequenceRef } from '../lims';

export type InlineRnaSequenceRef = Extract<RnaSequenceRef, { mode: 'inline' }>;

export async function buildInlineRnaSequenceRef(bases: string): Promise<InlineRnaSequenceRef> {
  const cleaned = bases.replace(/\s/g, '');
  return {
    mode: 'inline',
    bases: cleaned,
    topology: 'linear',
    length: cleaned.length,
    contentHash: await computeChecksum(cleaned),
  };
}
