import {
  SEQUENCE_PACKAGE_LEGACY_PAYLOAD_DIR,
  SEQUENCE_PACKAGE_PAYLOAD_DIR,
  SEQUENCE_PRIMERS_DIR,
} from './sequence-package-contract';
import { createDefaultSequenceEntityMetadata } from '../shared/sequence-entity-schema';

export function migrateSequencePackageV1ToV2(
  doc: Record<string, unknown>
): Record<string, unknown> {
  const members = Array.isArray(doc.members)
    ? doc.members.map((entry) => rewriteLegacyPayloadPath(entry))
    : [];
  return {
    ...doc,
    formatVersion: 2,
    members,
  };
}

export function migrateSequencePackageV2ToV3(
  doc: Record<string, unknown>
): Record<string, unknown> {
  const assembly = rewriteAssemblyPrimerPaths(doc.assembly);
  const primerPaths = collectedPrimerRelPaths(assembly);
  const members = upsertPrimerExportMembers(
    Array.isArray(doc.members) ? doc.members.map((entry) => rewriteLegacyPayloadPath(entry)) : [],
    primerPaths
  );
  return {
    ...doc,
    formatVersion: 3,
    ...(assembly !== undefined ? { assembly } : {}),
    members,
  };
}

export function migrateSequencePackageV3ToV4(
  doc: Record<string, unknown>
): Record<string, unknown> {
  if (!isPlainObject(doc.assembly)) {
    return { ...doc, formatVersion: 4 };
  }
  const assembly: Record<string, unknown> = { ...doc.assembly };
  delete assembly.primers;
  return {
    ...doc,
    formatVersion: 4,
    assembly,
  };
}

export function migrateSequencePackageV4ToV5(
  doc: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...doc,
    formatVersion: 5,
    entity: doc.entity ?? createDefaultSequenceEntityMetadata(),
  };
}

export function migrateSequencePackageV5ToV6(
  doc: Record<string, unknown>
): Record<string, unknown> {
  if (!isPlainObject(doc.entity) || !isPlainObject(doc.entity.schema)) {
    return { ...doc, formatVersion: 6 };
  }
  const entity = { ...doc.entity };
  const schema = { ...doc.entity.schema };
  if (!Number.isInteger(schema.version) || Number(schema.version) < 1) {
    schema.version = 1;
  }
  entity.schema = schema;
  return {
    ...doc,
    formatVersion: 6,
    entity,
  };
}

export function migrateSequencePackageV6ToV7(
  doc: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...doc,
    formatVersion: 7,
    versionHistory: doc.versionHistory ?? {
      schema: 'waypoint.sequence-history.v1',
      headId: null,
      revisions: [],
    },
  };
}

export function migrateSequencePackageV7ToV8(
  doc: Record<string, unknown>
): Record<string, unknown> {
  const members = Array.isArray(doc.members) ? doc.members : [];
  const idCounts = new Map<string, number>();
  for (const member of members) {
    if (!isPlainObject(member) || member.role !== 'user' || typeof member.id !== 'string') continue;
    idCounts.set(member.id, (idCounts.get(member.id) ?? 0) + 1);
  }
  const entries: Array<[string, { memberId: string; sha256: null }]> = [];
  for (const [index, member] of members.entries()) {
    if (!isPlainObject(member) || member.role !== 'user' || typeof member.id !== 'string') continue;

    const attachmentId =
      idCounts.get(member.id) === 1 ? member.id : `legacy-member:${index}:${member.id}`;
    entries.push([attachmentId, { memberId: member.id, sha256: null }]);
  }
  return { ...doc, formatVersion: 8, userAttachments: Object.fromEntries(entries) };
}

export function migrateSequencePackageV8ToV9(
  doc: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...doc,
    formatVersion: 9,
    versionHistory: doc.versionHistory ?? {
      schema: 'waypoint.sequence-history.v1',
      headId: null,
      revisions: [],
    },
  };
}

function rewriteLegacyPayloadPath(entry: unknown): unknown {
  if (!isPlainObject(entry)) return entry;
  if (typeof entry.path !== 'string') return entry;
  return {
    ...entry,
    path: rewriteManagedRelPath(entry.path),
  };
}

function rewriteAssemblyPrimerPaths(assembly: unknown): unknown {
  if (assembly === undefined) return undefined;
  if (!isPlainObject(assembly)) return assembly;
  const next: Record<string, unknown> = { ...assembly };
  if (isPlainObject(assembly.primers)) {
    const primers: Record<string, unknown> = { ...assembly.primers };
    if (typeof primers.csv === 'string') primers.csv = rewritePrimerRelPath(primers.csv);
    if (typeof primers.fasta === 'string') primers.fasta = rewritePrimerRelPath(primers.fasta);
    next.primers = primers;
  }
  if (isPlainObject(assembly.accepted) && isPlainObject(assembly.accepted.artifacts)) {
    next.accepted = {
      ...assembly.accepted,
      artifacts: rewritePrimerArtifactRecord(assembly.accepted.artifacts),
    };
  }
  if (Array.isArray(assembly.history)) {
    next.history = assembly.history.map((entry) => {
      if (!isPlainObject(entry) || !isPlainObject(entry.artifacts)) return entry;
      return { ...entry, artifacts: rewritePrimerArtifactRecord(entry.artifacts) };
    });
  }
  return next;
}

function rewritePrimerArtifactRecord(artifacts: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...artifacts };
  for (const key of ['primerCsvPath', 'primerFastaPath'] as const) {
    if (typeof next[key] === 'string') {
      next[key] = rewritePrimerRelPath(next[key]);
    }
  }
  return next;
}

function collectedPrimerRelPaths(assembly: unknown): string[] {
  if (!isPlainObject(assembly) || !isPlainObject(assembly.primers)) return [];
  return [assembly.primers.csv, assembly.primers.fasta].filter(
    (path): path is string => typeof path === 'string' && path.length > 0
  );
}

function upsertPrimerExportMembers(members: unknown[], primerPaths: readonly string[]): unknown[] {
  const next = [...members];
  for (const path of primerPaths) {
    const already = next.some(
      (entry) => isPlainObject(entry) && typeof entry.path === 'string' && entry.path === path
    );
    if (already) continue;
    const name = path.replace(/\\/g, '/').split('/').pop() ?? path;
    next.push({
      id: `primer-export:${name}`,
      role: 'primer-export',
      path,
      replaceable: true,
      createdAt: '1970-01-01T00:00:00.000Z',
    });
  }
  return next;
}

export function rewriteManagedRelPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(
      new RegExp(`^${SEQUENCE_PACKAGE_LEGACY_PAYLOAD_DIR}/`),
      `${SEQUENCE_PACKAGE_PAYLOAD_DIR}/`
    );
}

export function rewritePrimerRelPath(path: string): string {
  const normalized = rewriteManagedRelPath(path);
  return normalized.replace(
    new RegExp(`^${SEQUENCE_PRIMERS_DIR}/`),
    `${SEQUENCE_PACKAGE_PAYLOAD_DIR}/`
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export const SEQUENCE_PACKAGE_MIGRATOR_FNS: Record<
  string,
  (doc: Record<string, unknown>) => Record<string, unknown>
> = {
  migrateSequencePackageV1ToV2,
  migrateSequencePackageV2ToV3,
  migrateSequencePackageV3ToV4,
  migrateSequencePackageV4ToV5,
  migrateSequencePackageV5ToV6,
  migrateSequencePackageV6ToV7,
  migrateSequencePackageV7ToV8,
  migrateSequencePackageV8ToV9,
};
