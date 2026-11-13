import { computeChecksum } from '@waypoint/sequence-utils';
import type { InlineDnaSequenceRef } from '../lims';

export async function buildInlineDnaSequenceRef(bases: string): Promise<InlineDnaSequenceRef> {
  const cleaned = bases.replace(/\s/g, '');
  return {
    mode: 'inline',
    bases: cleaned,
    topology: 'linear',
    length: cleaned.length,
    contentHash: await computeChecksum(cleaned),
  };
}
