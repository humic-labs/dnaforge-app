import { resolveSidecarBaseUrl, sidecarFetch } from '../../services/sidecar-session';
import { pileupSourceRequestFields, type PileupSource } from './pileup-source';

export interface AlignmentHeaderResult {
  readonly format: 'bam' | 'cram';
  readonly isCram: boolean;
  readonly referenceRequired: boolean;
  readonly references: ReadonlyArray<{
    readonly name: string;
    readonly length: number;
    readonly md5: string | null;
  }>;
  readonly index: { readonly state: 'present' | 'missing' | 'unknown' };
}

export interface AlignmentReferenceIdentity {
  readonly name: string;
  readonly length: number;
  readonly aliases?: ReadonlyArray<string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function readAlignmentHeader(
  source: PileupSource,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<AlignmentHeaderResult> {
  const baseUrl = (
    source.remote?.tileBaseUrl ?? (await resolveSidecarBaseUrl('alignment-header'))
  ).replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await sidecarFetch(
      `${baseUrl}/tiles/alignment/header`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pileupSourceRequestFields(source)),
        signal: controller.signal,
      },
      fetchImpl
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        errorDetail(body) ?? `Could not read the alignment header (HTTP ${response.status}).`
      );
    }
    return body as AlignmentHeaderResult;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function requireReadableAlignmentIndex(header: AlignmentHeaderResult): void {
  if (header.index.state === 'present') return;
  const format = header.isCram ? 'CRAM' : 'BAM';
  const extensions = header.isCram ? '.crai or .csi' : '.bai or .csi';
  throw new Error(
    header.index.state === 'missing'
      ? `This ${format} needs a matching ${extensions} index beside it before it can be added.`
      : `Could not verify the ${format} index.`
  );
}

export function requireExactAlignmentReferenceMatch(input: {
  readonly alignmentReferences: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly expectedReferences: ReadonlyArray<AlignmentReferenceIdentity>;
  readonly genomeDisplayName: string;
  readonly alignmentFormat?: 'BAM' | 'CRAM';
}): void {
  const genomeDisplayName = input.genomeDisplayName.trim() || 'the open reference';
  const alignmentFormat = input.alignmentFormat ?? 'BAM';
  if (input.expectedReferences.length === 0) {
    throw new Error(
      `Cannot validate ${alignmentFormat} compatibility with ${genomeDisplayName}: no expected references were provided.`
    );
  }

  const alignmentByName = new Map<string, AlignmentReferenceIdentity>();
  for (const reference of input.alignmentReferences) {
    requireValidReferenceIdentity(reference, alignmentFormat, alignmentFormat, genomeDisplayName);
    if (alignmentByName.has(reference.name)) {
      throw new Error(
        `Cannot validate ${alignmentFormat} compatibility with ${genomeDisplayName}: duplicate ${alignmentFormat} reference "${reference.name}".`
      );
    }
    alignmentByName.set(reference.name, reference);
  }

  const expectedNames = new Set<string>();
  const incompatibilities: string[] = [];
  for (const expected of input.expectedReferences) {
    requireValidReferenceIdentity(expected, 'expected', alignmentFormat, genomeDisplayName);
    if (expectedNames.has(expected.name)) {
      throw new Error(
        `Cannot validate ${alignmentFormat} compatibility with ${genomeDisplayName}: duplicate expected reference "${expected.name}".`
      );
    }
    expectedNames.add(expected.name);

    const actual = alignmentByName.get(expected.name);
    if (!actual) {
      const alias = input.alignmentReferences.find(
        (candidate) =>
          normalizeReferenceName(candidate.name) === normalizeReferenceName(expected.name)
      );
      incompatibilities.push(
        `missing exact reference "${expected.name}" (expected ${expected.length} bp)` +
          (alias
            ? `; found alias-like reference "${alias.name}", but aliases are not remapped`
            : '')
      );
      continue;
    }
    if (actual.length !== expected.length) {
      incompatibilities.push(
        `reference "${expected.name}" is ${actual.length} bp in the ${alignmentFormat}, expected ${expected.length} bp`
      );
    }
  }

  if (incompatibilities.length > 0) {
    throw new Error(
      `${alignmentFormat} is incompatible with ${genomeDisplayName}: ${incompatibilities.join('; ')}.`
    );
  }
}

function requireValidReferenceIdentity(
  reference: AlignmentReferenceIdentity,
  owner: 'BAM' | 'CRAM' | 'expected',
  alignmentFormat: 'BAM' | 'CRAM',
  genomeDisplayName: string
): void {
  if (!reference.name.trim()) {
    throw new Error(
      `Cannot validate ${alignmentFormat} compatibility with ${genomeDisplayName}: ${owner} reference has an empty name.`
    );
  }
  if (!Number.isSafeInteger(reference.length) || reference.length <= 0) {
    throw new Error(
      `Cannot validate ${alignmentFormat} compatibility with ${genomeDisplayName}: ${owner} reference "${reference.name}" has invalid length ${String(reference.length)}.`
    );
  }
}

function normalizeReferenceName(value: string): string {
  return value.replace(/^chr/i, '').toLowerCase();
}

function errorDetail(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const detail = (body as { detail?: unknown }).detail;
  return typeof detail === 'string' && detail.trim() ? detail.trim() : null;
}
