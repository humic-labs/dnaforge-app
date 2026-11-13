export type IdentityConfidence = 'authoritative' | 'exact' | 'strong' | 'heuristic' | 'degraded';

export type IdentityEvidenceKind =
  | 'allele_translation'
  | 'qualifier_translation'
  | 'qualifier_translation_invalid'
  | 'qualifier_translation_mismatch'
  | 'derived_cds_translation'
  | 'registered_protein_entity'
  | 'initiator_normalization'
  | 'internal_stop'
  | 'non_standard_residue'
  | 'protein_invalid_residue'
  | 'canonicalization_mismatch'
  | 'genbank_db_xref'
  | 'genbank_protein_id'
  | 'genbank_locus_tag'
  | 'genbank_gene_name'
  | 'label_gene_token'
  | 'exact_sequence_checksum'
  | 'exact_sequence_no_match'
  | 'ambiguous_exact_sequence'
  | 'provider_cross_reference'
  | 'provider_validation'
  | 'provider_metadata'
  | 'provider_no_match'
  | 'provider_error'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'similarity_search';

export interface IdentityEvidenceInput {
  schemaVersion: 2;
  kind: IdentityEvidenceKind;
  source: 'genbank' | 'sequence_viewer' | 'uniprot' | 'rcsb' | 'alphafold' | 'waypoint';
  confidence: IdentityConfidence;
  label: string;
  details?: Record<string, string | number | boolean | null | undefined>;
}

export interface IdentityEvidence {
  schemaVersion: 2;
  id: string;
  kind: IdentityEvidenceKind;
  source: IdentityEvidenceInput['source'];
  confidence: IdentityConfidence;
  label: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface FeatureLocationSegment {
  start0: number;
  end0: number;
  strand: 1 | -1;
}

export interface FeatureIdentityInput {
  type: string;
  label?: string;
  entityId?: string;
  circular: boolean;
  segments: FeatureLocationSegment[];
  hintSummary: {
    dbXrefCount: number;
    hasProteinId: boolean;
    hasLocusTag: boolean;
    hasGeneName: boolean;
    taxonId?: number;
  };
  evidenceIds?: string[];
}

export interface FeatureIdentity {
  kind: 'sequence_feature';
  entityId?: string;
  featureKey: string;
  label?: string;
  location: {
    segments: FeatureLocationSegment[];
    circular: boolean;
  };
  hintSummary: FeatureIdentityInput['hintSummary'];
  evidenceIds: string[];
}

export type StructureProteinSource =
  | 'allele_translation'
  | 'qualifier_translation'
  | 'derived_cds'
  | 'standalone_protein_entity';

export interface ProteinSequenceIdentity {
  kind: 'protein_sequence';
  schemaVersion: 2;
  identityKey: string;
  canonicalizationStatus: 'renderer_preflight' | 'sidecar_confirmed';
  lookupSequence: string;
  canonicalLookupSequence: string;
  length: number;
  source: StructureProteinSource;
  rawSequence?: string;
  derivedSequence?: string;
  qualifierSequence?: string;
  startCodon: string | null;
  initiatorNormalized: boolean;
  translationConfig?: {
    geneticCode: number;
    frame: 0 | 1 | 2;
  };
  digests: {
    md5?: string;
    sha256: string;
  };
  evidenceIds: string[];
}

export interface ExternalProteinMatch {
  id: string;
  kind: 'uniprot';
  accession: string;
  providerIdentityKey: string;
  reviewed?: boolean;
  taxonId?: number;
  organism?: string;
  match: 'exact_sequence' | 'xref' | 'id_mapping' | 'name_search';
  sequenceIdentity?: number;
  checksumMd5?: string;
  rank: number;
  rankReasons: string[];
  selected: boolean;
  lastValidatedAt?: string;
  evidenceIds: string[];
}

export type ExternalProteinIdentity =
  | {
      kind: 'uniprot';
      id: string;
      accession: string;
      providerIdentityKey: string;
      reviewed?: boolean;
      taxonId?: number;
      organism?: string;
      match: 'exact_sequence' | 'xref' | 'id_mapping' | 'name_search';
      sequenceIdentity?: number;
      checksumMd5?: string;
      rankReasons?: string[];
      lastValidatedAt?: string;
      evidenceIds: string[];
    }
  | {
      kind: 'refseq_protein' | 'genbank_protein' | 'ncbi_gene' | 'gene_symbol';
      id: string;
      taxonId?: number;
      evidenceIds: string[];
    };

export interface ProteinResolutionSet {
  kind: 'protein_resolution_set';
  queryMd5: string;
  selectedExternalProteinId: string | null;
  matches: ExternalProteinMatch[];
  evidenceIds: string[];
}

export type StructureIdentity =
  | {
      kind: 'rcsb';
      id: string;
      pdbId: string;
      providerIdentityKey: string;
      pdbEntityId?: string;
      labelAsymIds?: string[];
      authAsymIds?: string[];
      assemblyId?: string;
      uniprotIds?: string[];
      referenceSequenceIds?: string[];
      entitySequenceLength?: number;
      chainCoverage?: number;
      source: 'direct_xref' | 'uniprot_xref' | 'rcsb_metadata' | 'sequence_similarity';
      sequenceIdentity?: number;
      coverage?: number;
      lastValidatedAt?: string;
      evidenceIds: string[];
    }
  | {
      kind: 'alphafold';
      id: string;
      accession: string;
      providerIdentityKey: string;
      modelId?: string;
      version?: string;
      fragment?: string;
      source: 'uniprot_accession' | 'provider_validation';
      meanPlddt?: number;
      lastValidatedAt?: string;
      evidenceIds: string[];
    };

export interface ProteinIdentityLedger {
  schemaVersion: 2;
  feature?: FeatureIdentity;
  sequence: ProteinSequenceIdentity;
  externalProteins: ExternalProteinIdentity[];
  resolutionSets: ProteinResolutionSet[];
  structures: StructureIdentity[];
  evidence: IdentityEvidence[];
}

export type CanonicalProteinResult =
  | {
      ok: true;
      sequence: string;
      exactLookupEligible: boolean;
      evidence: Array<
        { kind: 'internal_stop'; residue: '*' } | { kind: 'non_standard_residue'; residue: string }
      >;
    }
  | {
      ok: false;
      reason: 'empty' | 'invalid_residue';
      evidence: Array<{ kind: 'protein_invalid_residue'; residue?: string }>;
    };

const INITIATOR_CODONS = new Set(['ATG', 'GTG', 'TTG', 'CTG']);
const NON_STANDARD_RESIDUES = new Set(['U', 'O', 'X', 'B', 'Z', 'J']);
const TEXT_ENCODER = new TextEncoder();

export function canonicalProtein(input: string): CanonicalProteinResult {
  const withoutWhitespace = input.replace(/\p{White_Space}/gu, '');
  const upper = withoutWhitespace.toUpperCase();
  const sequence = upper.endsWith('*') ? upper.slice(0, -1) : upper;

  if (!sequence) {
    return {
      ok: false,
      reason: 'empty',
      evidence: [{ kind: 'protein_invalid_residue' }],
    };
  }

  for (const residue of sequence) {
    if (!/^[A-Z*]$/.test(residue)) {
      return {
        ok: false,
        reason: 'invalid_residue',
        evidence: [{ kind: 'protein_invalid_residue', residue }],
      };
    }
  }

  const evidence: Extract<CanonicalProteinResult, { ok: true }>['evidence'] = [];
  let exactLookupEligible = true;

  if (sequence.includes('*')) {
    exactLookupEligible = false;
    evidence.push({ kind: 'internal_stop', residue: '*' });
  }

  for (const residue of sequence) {
    if (NON_STANDARD_RESIDUES.has(residue)) {
      evidence.push({ kind: 'non_standard_residue', residue });
    }
  }

  return {
    ok: true,
    sequence,
    exactLookupEligible,
    evidence,
  };
}

export function normalizeInitiator(
  sequence: string,
  startCodon: string | null,
  source: StructureProteinSource
): { sequence: string; applied: boolean } {
  const codon = startCodon?.toUpperCase() ?? null;
  if (source !== 'derived_cds' || !sequence || !codon || !INITIATOR_CODONS.has(codon)) {
    return { sequence, applied: false };
  }
  if (sequence[0] === 'M') {
    return { sequence, applied: false };
  }
  return { sequence: `M${sequence.slice(1)}`, applied: true };
}

export function canonicalJson(value: unknown): string {
  return canonicalJsonInternal(value, { allowArrays: false });
}

export function canonicalJsonWithArrays(value: unknown): string {
  return canonicalJsonInternal(value, { allowArrays: true });
}

export function evidenceId(evidence: IdentityEvidenceInput): string {
  const payload = {
    schemaVersion: evidence.schemaVersion,
    kind: evidence.kind,
    source: evidence.source,
    confidence: evidence.confidence,
    label: evidence.label,
    details: evidence.details,
  };
  const digest = sha256Hex(canonicalJson(payload));
  return `ev:${evidence.kind}:${evidence.source}:${digest.slice(0, 16)}`;
}

export function makeIdentityEvidence(
  input: Omit<IdentityEvidenceInput, 'schemaVersion'>
): IdentityEvidence {
  const payload: IdentityEvidenceInput = { schemaVersion: 2, ...input };
  const details = stripUndefinedDetails(input.details);
  return {
    schemaVersion: 2,
    id: evidenceId(payload),
    kind: input.kind,
    source: input.source,
    confidence: input.confidence,
    label: input.label,
    ...(details ? { details } : {}),
  };
}

export function buildFeatureIdentity(input: FeatureIdentityInput): FeatureIdentity {
  const segments = [...input.segments].sort(
    (left, right) =>
      left.start0 - right.start0 || left.end0 - right.end0 || left.strand - right.strand
  );
  const keyPayload = canonicalJsonInternal(
    {
      schemaVersion: 2,
      kind: 'sequence_feature',
      type: input.type,
      entityId: input.entityId ?? null,
      label: input.label ?? null,
      circular: input.circular,
      segments,
    },
    { allowArrays: true }
  );

  return {
    kind: 'sequence_feature',
    entityId: input.entityId,
    featureKey: `feature:v2:${sha256Hex(keyPayload)}`,
    label: input.label,
    location: {
      segments,
      circular: input.circular,
    },
    hintSummary: input.hintSummary,
    evidenceIds: input.evidenceIds ?? [],
  };
}

export function buildProteinSequenceIdentity(input: {
  lookupSequence: string;
  rawSequence?: string;
  source: StructureProteinSource;
  startCodon: string | null;
  initiatorNormalized: boolean;
  translationConfig?: ProteinSequenceIdentity['translationConfig'];
  evidenceIds: string[];
}): ProteinSequenceIdentity | null {
  const canonical = canonicalProtein(input.lookupSequence);
  if (!canonical.ok) return null;
  const sha256 = sha256Hex(canonical.sequence);
  return {
    kind: 'protein_sequence',
    schemaVersion: 2,
    identityKey: `protein-sequence:v2:${sha256}`,
    canonicalizationStatus: 'renderer_preflight',
    lookupSequence: canonical.sequence,
    canonicalLookupSequence: canonical.sequence,
    length: canonical.sequence.length,
    source: input.source,
    rawSequence: input.rawSequence,
    startCodon: input.startCodon,
    initiatorNormalized: input.initiatorNormalized,
    ...(input.translationConfig ? { translationConfig: input.translationConfig } : {}),
    digests: { sha256 },
    evidenceIds: input.evidenceIds,
  };
}

export function buildIdentityRequestKey(featureKey: string, proteinIdentityKey: string): string {
  return `req:${featureKey}:${proteinIdentityKey}`;
}

function stripUndefinedDetails(
  details: IdentityEvidenceInput['details']
): Record<string, string | number | boolean | null> | undefined {
  if (!details) return undefined;
  const entries = Object.entries(details).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries) as Record<string, string | number | boolean | null>;
}

function canonicalJsonInternal(value: unknown, opts: { allowArrays: boolean }): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  }
  if (Array.isArray(value)) {
    if (!opts.allowArrays) {
      throw new Error('canonicalJson does not accept arrays');
    }
    return `[${value.map((item) => canonicalJsonInternal(item, opts)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(
        ([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJsonInternal(entryValue, opts)}`
      )
      .join(',')}}`;
  }
  throw new Error(`Unsupported canonical JSON value type: ${typeof value}`);
}

export function sha256Hex(input: string): string {
  const bytes = TEXT_ENCODER.encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 =
        rotr(words[index - 15], 7) ^ rotr(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 =
        rotr(words[index - 2], 17) ^ rotr(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

function rotr(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
