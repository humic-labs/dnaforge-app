export type SequenceFingerprintKind = 'dna' | 'rna' | 'protein';
export type SequenceFingerprintTopology = 'linear' | 'circular';

export interface SequenceFingerprintInput {
  kind: SequenceFingerprintKind;
  topology: SequenceFingerprintTopology;
  residues: string;
}

export const SEQUENCE_FINGERPRINT_VERSION = 'seq-v1';

const FINGERPRINT_PATTERN = /^seq-v1:(dna|rna|protein):(linear|circular):sha256:[0-9a-f]{64}$/;
const IGNORED_CHARACTERS = /[\s\d\-.~]/g;

export function normalizeFingerprintResidues(residues: string): string {
  return residues.replace(IGNORED_CHARACTERS, '').toUpperCase();
}

export function smallestRotationStart(value: string): number {
  const length = value.length;
  let first = 0;
  let second = 1;
  let offset = 0;
  while (first < length && second < length && offset < length) {
    const a = value.charCodeAt((first + offset) % length);
    const b = value.charCodeAt((second + offset) % length);
    if (a === b) {
      offset += 1;
      continue;
    }
    if (a > b) first += offset + 1;
    else second += offset + 1;
    if (first === second) second += 1;
    offset = 0;
  }
  return Math.min(first, second) % Math.max(length, 1);
}

export function canonicalFingerprintResidues(
  residues: string,
  topology: SequenceFingerprintTopology
): string {
  const normalized = normalizeFingerprintResidues(residues);
  if (topology === 'linear') return normalized;
  const start = smallestRotationStart(normalized);
  return normalized.slice(start) + normalized.slice(0, start);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function computeSequenceFingerprint(input: SequenceFingerprintInput): Promise<string> {
  const canonical = canonicalFingerprintResidues(input.residues, input.topology);
  const digest = await sha256Hex(canonical);
  return `${SEQUENCE_FINGERPRINT_VERSION}:${input.kind}:${input.topology}:sha256:${digest}`;
}

export function isSequenceFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value);
}
