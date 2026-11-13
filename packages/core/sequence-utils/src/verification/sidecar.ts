import type { VerificationResult } from './types';
import { SIDECAR_VERSION } from './types';

export const SIDECAR_EXTENSION = '.waypoint.json';

export function getSidecarPath(sourcePath: string): string {
  return `${sourcePath}${SIDECAR_EXTENSION}`;
}

export function isSidecarPath(path: string): boolean {
  return path.endsWith(SIDECAR_EXTENSION);
}

export function getSourcePath(sidecarPath: string): string | null {
  if (!isSidecarPath(sidecarPath)) return null;
  return sidecarPath.slice(0, -SIDECAR_EXTENSION.length);
}

export function serializeSidecar(result: VerificationResult): string {
  return JSON.stringify(result, null, 2);
}

export function parseSidecar(content: string): VerificationResult {
  let data: unknown;

  try {
    data = JSON.parse(content);
  } catch (e) {
    throw new Error(`Invalid sidecar JSON: ${e instanceof Error ? e.message : 'parse error'}`);
  }

  if (!isVerificationResult(data)) {
    throw new Error('Invalid sidecar structure: missing required fields');
  }

  if (data.version !== SIDECAR_VERSION) {
    console.warn(
      `Sidecar version mismatch: expected ${SIDECAR_VERSION}, got ${data.version}. ` +
        'Results may be incomplete.'
    );
  }

  return data;
}

function isVerificationResult(data: unknown): data is VerificationResult {
  if (typeof data !== 'object' || data === null) return false;

  const obj = data as Record<string, unknown>;

  return (
    obj.type === 'verification' &&
    typeof obj.version === 'string' &&
    typeof obj.createdAt === 'string' &&
    typeof obj.reference === 'object' &&
    typeof obj.result === 'object' &&
    typeof obj.alignment === 'object' &&
    typeof obj.input === 'object'
  );
}

export async function computeChecksum(data: string | ArrayBuffer): Promise<string> {
  const buffer = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);

  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  return `sha256:${hashHex}`;
}

export async function matchesSequenceChecksumIgnoringCase(
  sequence: string,
  checksum: unknown
): Promise<boolean> {
  if (typeof checksum !== 'string') return false;
  for (const representation of new Set([
    sequence,
    sequence.toUpperCase(),
    sequence.toLowerCase(),
  ])) {
    if ((await computeChecksum(representation)) === checksum) return true;
  }
  return false;
}

export async function verifyChecksum(
  data: string | ArrayBuffer,
  expectedChecksum: string
): Promise<boolean> {
  const actualChecksum = await computeChecksum(data);
  return actualChecksum === expectedChecksum;
}

export function createRelativePath(sidecarPath: string, referencePath: string): string {
  const sidecarDir = sidecarPath.substring(0, sidecarPath.lastIndexOf('/'));
  const sidecarParts = sidecarDir.split('/').filter(Boolean);
  const refParts = referencePath.split('/').filter(Boolean);

  let commonLength = 0;
  while (
    commonLength < sidecarParts.length &&
    commonLength < refParts.length &&
    sidecarParts[commonLength] === refParts[commonLength]
  ) {
    commonLength++;
  }

  const upCount = sidecarParts.length - commonLength;
  const ups = Array(upCount).fill('..');
  const down = refParts.slice(commonLength);

  return [...ups, ...down].join('/');
}

export function resolveRelativePath(sidecarPath: string, relativePath: string): string {
  const sidecarDir = sidecarPath.substring(0, sidecarPath.lastIndexOf('/'));
  const parts = sidecarDir.split('/').filter(Boolean);

  for (const segment of relativePath.split('/')) {
    if (segment === '..') {
      parts.pop();
    } else if (segment !== '.') {
      parts.push(segment);
    }
  }

  if (sidecarPath.startsWith('/')) {
    return '/' + parts.join('/');
  }

  return parts.join('/');
}

export function createVerificationResult(params: {
  reference: {
    name: string;
    path: string;
    checksum: string;
    length?: number;
    circular?: boolean;
  };
  result: {
    status: 'pass' | 'fail' | 'warning' | 'error';
    identity: number;
    coverage?: number;
    mutations: VerificationResult['result']['mutations'];
    errorMessage?: string;
  };
  alignment: {
    algorithm: VerificationResult['alignment']['algorithm'];
    alignedRef: string;
    alignedQuery: string;
    score?: number;
  };
  input: {
    checksum: string;
    format: string;
    queryLength: number;
    filename?: string;
    averageQuality?: number;
  };
  notes?: string;
}): VerificationResult {
  return {
    type: 'verification',
    version: SIDECAR_VERSION,
    createdAt: new Date().toISOString(),
    reference: params.reference,
    result: params.result,
    alignment: params.alignment,
    input: params.input,
    notes: params.notes,
  };
}

export interface VerificationSummary {
  status: VerificationResult['result']['status'];
  identity: number;
  coverage: number;
  mutationCount: number;
  substitutions: number;
  insertions: number;
  deletions: number;
  inCds: number;
  nonSynonymous: number;
}

export function summarizeVerification(result: VerificationResult): VerificationSummary {
  const mutations = result.result.mutations;

  const substitutions = mutations.filter((m) => m.type === 'substitution').length;
  const insertions = mutations.filter((m) => m.type === 'insertion').length;
  const deletions = mutations.filter((m) => m.type === 'deletion').length;

  const inCds = mutations.filter((m) => m.classification?.in_cds).length;
  const nonSynonymous = mutations.filter(
    (m) => m.classification?.in_cds && m.classification.classification !== 'synonymous'
  ).length;

  return {
    status: result.result.status,
    identity: result.result.identity,
    coverage: result.result.coverage ?? 100,
    mutationCount: mutations.length,
    substitutions,
    insertions,
    deletions,
    inCds,
    nonSynonymous,
  };
}
