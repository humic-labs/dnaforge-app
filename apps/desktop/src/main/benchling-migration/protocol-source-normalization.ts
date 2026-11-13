import type {
  RelationshipEvidence,
  RelationshipEvidenceKind,
} from '../../shared/benchling-migration';
import type {
  ProtocolLink,
  ProtocolSlotDeclaration,
  ProtocolSlotValueType,
} from './protocol-document';

const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;
const EVIDENCE_KINDS = new Set<RelationshipEvidenceKind>([
  'stable_id',
  'url',
  'registry_id',
  'archive_path',
  'attachment_hash',
  'alias',
  'name',
  'timestamp',
  'source_type',
  'sequence_identity',
]);

export type ProtocolProjectionLinkInput =
  | {
      id: string;
      relation: string;
      state: 'exact';
      sourceTargetId: string;
      destinationTargetId: string;
      label?: string;
      evidence: RelationshipEvidence[];
    }
  | {
      id: string;
      relation: string;
      state: 'external';
      url: string;
      label?: string;
      evidence: RelationshipEvidence[];
    }
  | {
      id: string;
      relation: string;
      state: 'source_broken';
      sourceTargetId?: string;
      label?: string;
      evidence: RelationshipEvidence[];
    };

export function normalizeProtocolSlots(
  value: unknown,
  direction: 'inputs' | 'outputs'
): ProtocolSlotDeclaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Protocol ${direction} must be an array.`);
  const keys = new Set<string>();
  return value.map((entry, index) => {
    const raw = requireRecord(entry, `Protocol ${direction} ${index + 1} must be an object.`);
    const key = requireText(raw.key, `Protocol ${direction} ${index + 1} key`);
    if (!SAFE_KEY.test(key))
      throw new Error(`Protocol ${direction} ${index + 1} key is not portable.`);
    if (keys.has(key)) throw new Error(`Duplicate protocol ${direction} key: ${key}.`);
    keys.add(key);
    if (typeof raw.required !== 'boolean') {
      throw new Error(`Protocol ${direction} ${index + 1} required must be boolean.`);
    }
    return {
      key,
      label: requireText(raw.label, `Protocol ${direction} ${index + 1} label`),
      required: raw.required,
      description: optionalText(raw.description),
      valueType: normalizeValueType(raw.valueType, `Protocol ${direction} ${index + 1}`),
    };
  });
}

export function normalizeProtocolLinks(value: ProtocolProjectionLinkInput[]): ProtocolLink[] {
  if (!Array.isArray(value)) throw new Error('Protocol resolved links must be an array.');
  const ids = new Set<string>();
  return value.map((link, index) => {
    const id = requireText(link.id, `Protocol link ${index + 1} ID`);
    if (ids.has(id)) throw new Error(`Duplicate protocol link ID: ${id}.`);
    ids.add(id);
    const relation = requireText(link.relation, `Protocol link ${index + 1} relation`);
    const label = optionalText(link.label);
    const evidence = normalizeEvidence(link.evidence, index);
    if (link.state === 'exact') {
      return {
        id,
        relation,
        state: 'live_local',
        sourceTargetId: requireText(
          link.sourceTargetId,
          `Protocol link ${index + 1} source target ID`
        ),
        destinationTargetId: requireText(
          link.destinationTargetId,
          `Protocol link ${index + 1} destination target ID`
        ),
        label,
        evidence,
      };
    }
    if (link.state === 'external') {
      return {
        id,
        relation,
        state: 'external',
        url: sanitizeExternalUrl(link.url, `Protocol link ${index + 1} URL`),
        label,
        evidence,
      };
    }
    if (link.state === 'source_broken') {
      return {
        id,
        relation,
        state: 'source_broken',
        sourceTargetId: optionalText(link.sourceTargetId),
        label,
        evidence,
      };
    }
    throw new Error(
      `Protocol link ${index + 1} must already be exact, external, or source-broken.`
    );
  });
}

export function portableProtocolVersionLink(link: ProtocolLink): Record<string, unknown> {
  if (link.state === 'live_local') {
    return {
      id: link.id,
      relation: link.relation,
      state: 'exact',
      sourceTargetId: link.sourceTargetId,
      label: link.label,
      evidence: link.evidence,
    };
  }
  if (link.state === 'external') {
    return {
      id: link.id,
      relation: link.relation,
      state: link.state,
      url: link.url,
      label: link.label,
      evidence: link.evidence,
    };
  }
  return {
    id: link.id,
    relation: link.relation,
    state: link.state,
    sourceTargetId: link.sourceTargetId,
    label: link.label,
    evidence: link.evidence,
  };
}

function normalizeValueType(value: unknown, label: string): ProtocolSlotValueType {
  const raw = requireRecord(value, `${label} valueType must be an object.`);
  const kind = requireText(raw.kind, `${label} valueType kind`);
  if (
    [
      'text',
      'number',
      'boolean',
      'date',
      'dna_sequence',
      'rna_sequence',
      'protein_sequence',
    ].includes(kind)
  ) {
    return { kind } as ProtocolSlotValueType;
  }
  if (kind === 'quantity') {
    return {
      kind,
      unitDimension: optionalText(raw.unitDimension),
      preferredUnit: optionalText(raw.preferredUnit),
    };
  }
  if (kind === 'record') {
    return {
      kind,
      recordKinds: normalizedTextList(raw.recordKinds, `${label} recordKinds`, true),
    };
  }
  if (kind === 'attachment') {
    return {
      kind,
      mediaTypes: normalizedTextList(raw.mediaTypes, `${label} mediaTypes`, false),
    };
  }
  throw new Error(`Unsupported ${label} valueType "${kind}".`);
}

function normalizeEvidence(
  value: RelationshipEvidence[],
  linkIndex: number
): RelationshipEvidence[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Protocol link ${linkIndex + 1} requires relationship evidence.`);
  }
  const byIdentity = new Map<string, RelationshipEvidence>();
  for (const [evidenceIndex, entry] of value.entries()) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(
        `Protocol link ${linkIndex + 1} evidence ${evidenceIndex + 1} must be an object.`
      );
    }
    const kind = requireText(
      entry.kind,
      `Protocol link ${linkIndex + 1} evidence kind`
    ) as RelationshipEvidenceKind;
    if (!EVIDENCE_KINDS.has(kind)) {
      throw new Error(`Protocol link ${linkIndex + 1} evidence has an unsupported kind.`);
    }
    const evidence: RelationshipEvidence = {
      kind,
      value: requireText(entry.value, `Protocol link ${linkIndex + 1} evidence value`),
      ...(entry.sourcePath
        ? { sourcePath: requireText(entry.sourcePath, 'Evidence source path') }
        : {}),
    };
    byIdentity.set(stableJson(evidence), evidence);
  }
  return [...byIdentity.values()].sort((left, right) =>
    stableJson(left).localeCompare(stableJson(right))
  );
}

function sanitizeExternalUrl(value: unknown, label: string): string {
  const text = requireText(value, label);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${label} must use credential-free HTTP or HTTPS.`);
  }
  return parsed.toString();
}

function normalizedTextList(value: unknown, label: string, requireOne: boolean): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const entries = [
    ...new Set(value.map((entry, index) => requireText(entry, `${label} ${index + 1}`))),
  ].sort();
  if (requireOne && entries.length === 0) throw new Error(`${label} requires at least one value.`);
  return entries;
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requireText(value, 'Optional text');
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  if (/[\0\r\n]/.test(value)) throw new Error(`${label} must be single-line text.`);
  return value.trim();
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)])
  );
}
