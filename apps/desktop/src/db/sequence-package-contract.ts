export const SEQUENCE_PACKAGE_SCHEMA = 'waypoint.sequence.v1' as const;

export const SEQUENCE_PACKAGE_SCHEMA_ALIASES = [
  SEQUENCE_PACKAGE_SCHEMA,
  'waypoint.plasmid.v1',
] as const;

export const SEQUENCE_PACKAGE_KIND = 'sequence' as const;
export const SEQUENCE_PACKAGE_KIND_ALIASES = [SEQUENCE_PACKAGE_KIND, 'plasmid'] as const;

export const SEQUENCE_PACKAGE_META_NAME = 'plasmid.json' as const;
export const SEQUENCE_PACKAGE_META_ALIASES = [SEQUENCE_PACKAGE_META_NAME] as const;

export const SEQUENCE_PACKAGE_METADATA_TRANSACTION_NAME =
  'sequence-metadata-transaction.json' as const;

export const SEQUENCE_PACKAGE_REVISION_JOURNAL_NAME = 'sequence-revision-publication.json' as const;

export const SEQUENCE_PACKAGE_FILE_KIND = 'waypoint-sequence' as const;
export const SEQUENCE_PACKAGE_FILE_KIND_ALIASES = [
  SEQUENCE_PACKAGE_FILE_KIND,
  'waypoint-plasmid',
] as const;

export const SEQUENCE_PACKAGE_FORMAT_VERSION = 9 as const;

export const SEQUENCE_PACKAGE_PAYLOAD_DIR = 'contents' as const;

export const SEQUENCE_PACKAGE_LEGACY_PAYLOAD_DIR = 'files' as const;

export const SEQUENCE_PACKAGE_V1_MEMBER_DIRS = ['primers', 'assets'] as const;

export const SEQUENCE_PRIMERS_DIR = 'primers' as const;
export const SEQUENCE_ASSETS_DIR = 'assets' as const;

export interface SequencePackageMigratorSpec {
  readonly from: number;
  readonly to: number;

  readonly name: string;

  readonly disk?: string;
}

export const SEQUENCE_MEMBER_ROLES = [
  'sequencing-read',
  'primer-export',
  'alignment',
  'evidence-input',
  'evidence-result',
  'assembly-working-copy',
  'sequence-snapshot',
  'user',
] as const;
export type SequenceMemberRole = (typeof SEQUENCE_MEMBER_ROLES)[number];

export const SEQUENCE_PACKAGE_MIGRATORS: readonly SequencePackageMigratorSpec[] = [
  { from: 1, to: 2, name: 'migrateSequencePackageV1ToV2' },
  {
    from: 2,
    to: 3,
    name: 'migrateSequencePackageV2ToV3',
    disk: 'relocateSequencePackageV2ToV3',
  },
  {
    from: 3,
    to: 4,
    name: 'migrateSequencePackageV3ToV4',
    disk: 'relocateSequencePackageV3ToV4',
  },
  { from: 4, to: 5, name: 'migrateSequencePackageV4ToV5' },
  { from: 5, to: 6, name: 'migrateSequencePackageV5ToV6' },
  { from: 6, to: 7, name: 'migrateSequencePackageV6ToV7' },
  { from: 7, to: 8, name: 'migrateSequencePackageV7ToV8' },
  { from: 8, to: 9, name: 'migrateSequencePackageV8ToV9' },
];

export function isSequencePackageSchema(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (SEQUENCE_PACKAGE_SCHEMA_ALIASES as readonly string[]).includes(value)
  );
}

export function isSequencePackageKind(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (SEQUENCE_PACKAGE_KIND_ALIASES as readonly string[]).includes(value)
  );
}

export function isSequencePackageFileKind(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (SEQUENCE_PACKAGE_FILE_KIND_ALIASES as readonly string[]).includes(value)
  );
}

export function isKnownSequenceMemberRole(value: unknown): value is SequenceMemberRole {
  return typeof value === 'string' && (SEQUENCE_MEMBER_ROLES as readonly string[]).includes(value);
}

export function assertKnownSequenceMemberRole(value: string): SequenceMemberRole {
  if (!isKnownSequenceMemberRole(value)) {
    throw new Error(
      `Unknown sequence package member role "${value}". Add it to SEQUENCE_MEMBER_ROLES.`
    );
  }
  return value;
}
