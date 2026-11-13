export type EntityImportType =
  | 'dna-sequences'
  | 'dna-oligos'
  | 'rna-oligos'
  | 'primers'
  | 'strains'
  | 'proteins'
  | 'registry-types';

export type EntityImportDestination = { kind: 'explicit'; path: string } | { kind: 'choose' };

export interface EntityImportRequest {
  entityType: EntityImportType;
  destination: EntityImportDestination;
}

export interface DnaSequenceImportIntent {
  entityType: 'dna-sequences';
}
