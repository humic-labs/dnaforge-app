import { describe, expect, it } from 'vitest';
import {
  canonicalFingerprintResidues,
  computeSequenceFingerprint,
  isSequenceFingerprint,
  smallestRotationStart,
} from './sequence-fingerprint';

function bruteForceSmallestRotation(value: string): string {
  let best = value;
  for (let start = 1; start < value.length; start += 1) {
    const rotation = value.slice(start) + value.slice(0, start);
    if (rotation < best) best = rotation;
  }
  return best;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe('sequence fingerprint seq-v1', () => {
  it('keeps frozen digests for the published vectors', async () => {
    await expect(
      computeSequenceFingerprint({ kind: 'dna', topology: 'linear', residues: 'ACGT' })
    ).resolves.toBe(
      'seq-v1:dna:linear:sha256:1dff3e84fe7877e0673b69bbddcf40124e396e3f9943dd890c91b6a09adb9af0'
    );
    await expect(
      computeSequenceFingerprint({ kind: 'dna', topology: 'circular', residues: 'GTAC' })
    ).resolves.toBe(
      'seq-v1:dna:circular:sha256:1dff3e84fe7877e0673b69bbddcf40124e396e3f9943dd890c91b6a09adb9af0'
    );
    await expect(
      computeSequenceFingerprint({ kind: 'protein', topology: 'linear', residues: 'MKV*' })
    ).resolves.toBe(
      'seq-v1:protein:linear:sha256:7a6b28e35ba51a92c105cfec8f4002d323eee3b9e4c2d5cbc20c789200b69b34'
    );
  });

  it('gives every start position of a circular sequence one fingerprint', async () => {
    const plasmid = 'TTGACAGCTAGCTCAGTCCTAGGTATAATGCTAGC';
    const expected = await computeSequenceFingerprint({
      kind: 'dna',
      topology: 'circular',
      residues: plasmid,
    });
    for (let start = 1; start < plasmid.length; start += 1) {
      const rotated = plasmid.slice(start) + plasmid.slice(0, start);
      await expect(
        computeSequenceFingerprint({ kind: 'dna', topology: 'circular', residues: rotated })
      ).resolves.toBe(expected);
    }
  });

  it('distinguishes start positions of a linear sequence', async () => {
    const first = await computeSequenceFingerprint({
      kind: 'dna',
      topology: 'linear',
      residues: 'AACG',
    });
    const rotated = await computeSequenceFingerprint({
      kind: 'dna',
      topology: 'linear',
      residues: 'ACGA',
    });
    expect(rotated).not.toBe(first);
  });

  it('keeps strand: a reverse complement is a different sequence', async () => {
    const forward = await computeSequenceFingerprint({
      kind: 'dna',
      topology: 'circular',
      residues: 'AAACCG',
    });
    const reverseComplement = await computeSequenceFingerprint({
      kind: 'dna',
      topology: 'circular',
      residues: 'CGGTTT',
    });
    expect(reverseComplement).not.toBe(forward);
  });

  it('ignores case, whitespace, numbering and gap characters', async () => {
    const plain = await computeSequenceFingerprint({
      kind: 'dna',
      topology: 'linear',
      residues: 'ACGTNNACGT',
    });
    const genbankOrigin = await computeSequenceFingerprint({
      kind: 'dna',
      topology: 'linear',
      residues: '        1 acgtnn-acg\n       10 t.~',
    });
    expect(genbankOrigin).toBe(plain);
  });

  it('never matches across molecule kinds or topologies', async () => {
    const residues = 'ACGU';
    const fingerprints = await Promise.all([
      computeSequenceFingerprint({ kind: 'dna', topology: 'linear', residues }),
      computeSequenceFingerprint({ kind: 'rna', topology: 'linear', residues }),
      computeSequenceFingerprint({ kind: 'protein', topology: 'linear', residues }),
      computeSequenceFingerprint({ kind: 'dna', topology: 'circular', residues }),
    ]);
    expect(new Set(fingerprints).size).toBe(4);
  });

  it('finds the smallest rotation for repetitive and random sequences', () => {
    const random = seededRandom(7);
    const cases = ['', 'A', 'AAAA', 'ABAB', 'BABA', 'CGCGCG', 'TTTTA', 'ACACACAA'];
    for (let index = 0; index < 400; index += 1) {
      const length = 1 + Math.floor(random() * 40);
      let value = '';
      for (let position = 0; position < length; position += 1) {
        value += 'ACG'[Math.floor(random() * 3)];
      }
      cases.push(value);
    }
    for (const value of cases) {
      expect(canonicalFingerprintResidues(value, 'circular')).toBe(
        bruteForceSmallestRotation(value)
      );
      expect(smallestRotationStart(value)).toBeLessThan(Math.max(value.length, 1));
    }
  });

  it('recognizes only well-formed seq-v1 fingerprints', async () => {
    const fingerprint = await computeSequenceFingerprint({
      kind: 'dna',
      topology: 'linear',
      residues: 'ACGT',
    });
    expect(isSequenceFingerprint(fingerprint)).toBe(true);
    expect(isSequenceFingerprint('sha256:' + '0'.repeat(64))).toBe(false);
    expect(isSequenceFingerprint(fingerprint.replace('seq-v1', 'seq-v2'))).toBe(false);
  });
});
