export const SEQUENCE_MIGRATION_DIRECTORY = '.dnaforge-sequence-migrations';
export const SEQUENCE_UPGRADE_DIRECTORY = '.dnaforge-sequence-upgrades';

export function isSequenceMigrationRecoveryPath(relativePath: string): boolean {
  const root = relativePath.split('/', 1)[0];
  return root === SEQUENCE_MIGRATION_DIRECTORY || root === SEQUENCE_UPGRADE_DIRECTORY;
}
