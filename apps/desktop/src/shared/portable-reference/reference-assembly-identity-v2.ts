import { sha256Hex } from '../sha256-sync';

export const REFERENCE_ASSEMBLY_IDENTITY_V2 = 'dnaforge-reference-assembly-identity.v2' as const;

export interface ReferenceAssemblyIdentityContigV2 {
  readonly sourceSeqId: string;
  readonly lengthBp: number;
  readonly circular: boolean;
  readonly normalizedSequenceSha256: string;
}

export function referenceAssemblyIdentitySha256V2(
  contigs: ReadonlyArray<ReferenceAssemblyIdentityContigV2>
): string {
  const canonical = contigs.map((contig) => ({
    sourceSeqId: contig.sourceSeqId,
    lengthBp: contig.lengthBp,
    topology: contig.circular ? 'circular' : 'linear',
    normalizedSequenceSha256: contig.normalizedSequenceSha256.toLowerCase(),
  }));
  return sha256Hex(`${REFERENCE_ASSEMBLY_IDENTITY_V2}\0`, JSON.stringify(canonical));
}
