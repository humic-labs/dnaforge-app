import type { ComponentType } from 'react';

export type ConfirmedEntityTypeId = 'dna-sequences' | 'primers' | 'strains';

export interface ConfirmedEntityType {
  id: ConfirmedEntityTypeId;
  label: string;
  singularLabel: string;
}

export const CONFIRMED_ENTITY_TYPES: readonly ConfirmedEntityType[] = [
  { id: 'dna-sequences', label: 'DNA sequences', singularLabel: 'DNA sequence' },
  { id: 'primers', label: 'Primers', singularLabel: 'Primer' },
  { id: 'strains', label: 'Strains', singularLabel: 'Strain' },
];

export const ENTITY_ACTIONS = ['Create', 'Import'] as const;

export const PROJECT_IMPORT_ACTIONS = [
  'Import a project',
  'Import with agent',
  'Migrate from Benchling',
] as const;

export type EntityAction = (typeof ENTITY_ACTIONS)[number];
export type ProjectImportAction = (typeof PROJECT_IMPORT_ACTIONS)[number];

export interface ImportPickerVariantProps {
  onRequestClose: () => void;
}

export interface ImportPickerVariantDefinition {
  id: string;
  name: string;
  description: string;
  component: ComponentType<ImportPickerVariantProps>;
}
