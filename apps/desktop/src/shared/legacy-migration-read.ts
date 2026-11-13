export interface LegacyMigrationFastaTarget {
  workspaceRoot: string;
  targetId: string;
}

export interface LegacyMigrationFastaRead extends LegacyMigrationFastaTarget {
  source: 'migration-index';
  destinationId: string;
  path: string;
  readView: 'sequence' | 'protein';
  title: string;
  readOnly: true;
}
