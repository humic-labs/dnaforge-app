import { entityKindLabel } from './entity-types';

export const REGISTRY_ARTIFACT_SEARCH_PROJECTION_KEY = 'registryArtifactSearchProjection';

export type RegistryFileStorage = 'flat-file' | 'dir-package';

export const ENTITY_RECORD_ARTIFACT_SCHEMA = 'waypoint.entity.v1' as const;
export const ENTITY_RECORD_ARTIFACT_CURRENT_SCHEMA = 'waypoint.entity.v2' as const;
export const ENTITY_RECORD_ARTIFACT_SUFFIX = '.entity.json' as const;
export const TRACK_VIEW_FILE_SUFFIX = '.dnaforge-track-view.json' as const;
export const MOLECULAR_DOCUMENT_FILE_SUFFIX = '.dnaforge-molecular.json' as const;

export function isEntityRecordArtifactProjection(fields: Record<string, unknown>): boolean {
  const artifact = fields.artifact;
  return (
    typeof artifact === 'object' &&
    artifact !== null &&
    'schema' in artifact &&
    (artifact.schema === ENTITY_RECORD_ARTIFACT_SCHEMA ||
      artifact.schema === ENTITY_RECORD_ARTIFACT_CURRENT_SCHEMA)
  );
}

export interface RegistryFileType {
  id: string;

  label: string;

  storage: RegistryFileStorage;

  suffix: string;

  defaultDir?: string;

  treeHiddenCompoundSuffix?: string;

  registryProjected: boolean;
}

const registryFileFormats: readonly (Omit<RegistryFileType, 'label'> & { label?: string })[] = [
  {
    id: 'entity-record',
    label: 'Registry record',
    storage: 'flat-file',
    suffix: ENTITY_RECORD_ARTIFACT_SUFFIX,
    defaultDir: 'records',
    treeHiddenCompoundSuffix: ENTITY_RECORD_ARTIFACT_SUFFIX,
    registryProjected: true,
  },
  {
    id: 'primer',
    storage: 'flat-file',
    suffix: '.primer.json',
    defaultDir: 'primers',
    treeHiddenCompoundSuffix: '.primer.json',
    registryProjected: true,
  },
  {
    id: 'sequence',
    storage: 'dir-package',

    suffix: '.forge/plasmid.json',
    registryProjected: true,
  },
  {
    id: 'notebook',
    storage: 'dir-package',
    suffix: '.forge/notebook.json',
    registryProjected: true,
  },
  {
    id: 'selection',
    label: 'Saved selection',
    storage: 'flat-file',
    suffix: '.wpselection.json',
    defaultDir: 'Selections',
    treeHiddenCompoundSuffix: '.wpselection.json',
    registryProjected: false,
  },
  {
    id: 'design',
    storage: 'flat-file',
    suffix: '.wpdesign.json',
    treeHiddenCompoundSuffix: '.wpdesign.json',
    registryProjected: false,
  },
  {
    id: 'note',
    label: 'Note',
    storage: 'flat-file',
    suffix: '.wpnote.json',
    treeHiddenCompoundSuffix: '.wpnote.json',
    registryProjected: false,
  },
  {
    id: 'track-view',
    storage: 'flat-file',
    suffix: TRACK_VIEW_FILE_SUFFIX,
    treeHiddenCompoundSuffix: TRACK_VIEW_FILE_SUFFIX,
    registryProjected: true,
  },
  {
    id: 'molecular-document',
    storage: 'flat-file',
    suffix: MOLECULAR_DOCUMENT_FILE_SUFFIX,
    treeHiddenCompoundSuffix: MOLECULAR_DOCUMENT_FILE_SUFFIX,
    registryProjected: true,
  },
];

export const REGISTRY_FILE_TYPES: readonly RegistryFileType[] = registryFileFormats.map(
  (format) => ({
    ...format,
    label: format.label ?? entityKindLabel(format.id),
  })
);

export const TREE_HIDDEN_COMPOUND_SUFFIXES: readonly string[] = REGISTRY_FILE_TYPES.map(
  (t) => t.treeHiddenCompoundSuffix
)
  .filter((s): s is string => Boolean(s))
  .sort((a, b) => b.length - a.length);

export function registryFileType(id: string): RegistryFileType | undefined {
  return REGISTRY_FILE_TYPES.find((t) => t.id === id);
}
