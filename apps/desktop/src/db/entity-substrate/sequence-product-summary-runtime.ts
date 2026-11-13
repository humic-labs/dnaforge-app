import { parseGenBankFull, resolveSequenceGeneticCode } from '@waypoint/sequence-utils';
import type { ManagedSequenceContentSummary } from '../../shared/managed-sequence-document';

const MAX_PRODUCT_SUMMARIES = 256;
const summaries = new Map<string, ManagedSequenceContentSummary>();

export async function readSequenceProductSummary(
  content: string
): Promise<ManagedSequenceContentSummary> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  let summary = summaries.get(hash);
  if (summary) {
    summaries.delete(hash);
  } else {
    const sequence = parseGenBankFull(content, { featurePolicy: 'preserve' });
    summary = {
      length: sequence.length,
      topology: sequence.circular ? 'circular' : 'linear',
      geneticCode: resolveSequenceGeneticCode(sequence).code,
    };
  }
  summaries.set(hash, summary);
  if (summaries.size > MAX_PRODUCT_SUMMARIES) summaries.delete(summaries.keys().next().value!);
  return summary;
}

export interface SequenceProductSummaryRequest {
  id: number;
  content: string;
}

export type SequenceProductSummaryResponse =
  | { id: number; summary: ManagedSequenceContentSummary }
  | { id: number; error: { name: string; message: string } };
