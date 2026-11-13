import { sha256Hex } from '../sha256-sync';
import type { ReferenceContentIdentity } from '../reference-content-identity';

export function referenceContentIdentity(input: {
  readonly source: Readonly<{ fastaSha256: string; gffSha256?: string }>;
  readonly members: readonly Readonly<{
    chrom: string;
    sourceSeqId?: string;
    lengthBp?: number;
    circular?: boolean;
  }>[];
  readonly pipelineRevision: number;
  readonly annotationPreparation?: readonly Readonly<{
    themeMode: string;
    inventoryFingerprint: string;
  }>[];
}): ReferenceContentIdentity {
  return {
    sequenceIdentity: digest({
      contract: 'dnaforge.reference-sequence-identity.v1',
      fastaSha256: input.source.fastaSha256,
      chromosomes: input.members.map((member) => ({
        chrom: member.chrom,
        sourceSeqId: member.sourceSeqId ?? member.chrom,
        lengthBp: member.lengthBp,
        circular: member.circular ?? false,
      })),
    }),
    annotationIdentity: digest({
      contract: 'dnaforge.reference-annotation-identity.v1',
      gffSha256: input.source.gffSha256 ?? null,
      preparation: {
        pipelineRevision: input.pipelineRevision,
        ...(input.annotationPreparation ? { products: input.annotationPreparation } : {}),
      },
    }),
  };
}

function digest(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}
