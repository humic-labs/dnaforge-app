import { describe, expect, it } from 'vitest';

import { referenceAssemblyIdentitySha256V2 } from './reference-assembly-identity-v2';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('reference assembly identity v2', () => {
  it('is ordered and includes exact IDs, lengths, topology, and normalized bases', () => {
    const contigs = [
      {
        sourceSeqId: 'chr1',
        lengthBp: 4,
        circular: false,
        normalizedSequenceSha256: A,
      },
      {
        sourceSeqId: 'chrM',
        lengthBp: 2,
        circular: true,
        normalizedSequenceSha256: B,
      },
    ] as const;
    const identity = referenceAssemblyIdentitySha256V2(contigs);

    expect(referenceAssemblyIdentitySha256V2(contigs)).toBe(identity);
    expect(referenceAssemblyIdentitySha256V2([...contigs].reverse())).not.toBe(identity);
    expect(
      referenceAssemblyIdentitySha256V2([{ ...contigs[0], sourceSeqId: '1' }, contigs[1]])
    ).not.toBe(identity);
    expect(
      referenceAssemblyIdentitySha256V2([{ ...contigs[0], lengthBp: 5 }, contigs[1]])
    ).not.toBe(identity);
    expect(
      referenceAssemblyIdentitySha256V2([contigs[0], { ...contigs[1], circular: false }])
    ).not.toBe(identity);
    expect(
      referenceAssemblyIdentitySha256V2([
        { ...contigs[0], normalizedSequenceSha256: B },
        contigs[1],
      ])
    ).not.toBe(identity);
  });
});
