import {
  LINKABLE_CATALOG_ENTITY_TYPES,
  type EntityTypeIconKind,
} from '@waypoint/scientific-artifacts/shared/entity-types';
import type { EntityColorContext } from './entity-color-family';
import { isTabularRepresentation } from './tabular-file-types';

export const ENTITY_DISCOVERY_PROJECT_TYPES = LINKABLE_CATALOG_ENTITY_TYPES.map((type) =>
  type === 'notebook' ? 'page' : type
);

export type EntityDiscoveryType = (typeof ENTITY_DISCOVERY_PROJECT_TYPES)[number] | 'registry';

export const ENTITY_DISCOVERY_CATEGORY_KEYS = [
  'sequences',
  'primers',
  'notebooks',
  'structures',
  'tables',
  'records',
  'files',
] as const;
export type EntityDiscoveryCategoryKey = (typeof ENTITY_DISCOVERY_CATEGORY_KEYS)[number];

export interface EntityDiscoveryScope {
  projectId?: string;
  projectRoot?: string;
  projectRoots?: readonly string[];
  includeArchived?: boolean;
}

export interface EntityDiscoveryFilter {
  namedTypeKey?: string;
  category?: EntityDiscoveryCategoryKey;
  entityTypes?: readonly string[];
  registryKinds?: readonly string[];
  schemaId?: string;
  role?: 'primer';
}

export interface EntityDiscoveryRequest {
  query: string;
  scope?: EntityDiscoveryScope;
  filter?: EntityDiscoveryFilter;
  preferredProjectId?: string;
  preferredProjectRoot?: string;
  cursor?: string;
  limit?: number;
}

export interface EntityDescriptor {
  id: string;
  type: EntityDiscoveryType;
  name: string;
  sequenceLength?: number | null;
  source: 'project' | 'registry' | 'primer';
  namedTypeKey: string;
  iconKind: EntityTypeIconKind;
  iconContext?: EntityColorContext;
  kindLabel: string;
  path: string | null;
  contentHash: string | null;
  objectUuid: string | null;
  registryKind: string | null;
  registryId: string | null;
  schemaId: string | null;
  projectId: string | null;
  projectRoot: string | null;
  projectName: string | null;
  archived: boolean;
  localOnly?: boolean;
}

export interface EntityDiscoveryCoverage {
  catalog: number;
  registry: number;
  primers: number;
  excluded: number;
}

export interface EntityDiscoveryPage {
  items: EntityDescriptor[];
  nextCursor: string | null;
  generation: string;
  coverage: EntityDiscoveryCoverage;
}

export interface EntityDiscoveryResolveRequest {
  ids: readonly string[];
  scope?: EntityDiscoveryScope;
}

export interface EntityDiscoveryResolution {
  items: Array<
    | { id: string; status: 'available'; entity: EntityDescriptor }
    | { id: string; status: 'unavailable' }
  >;
  generation: string;
  coverage: EntityDiscoveryCoverage;
}

export interface EntityDiscoveryTypesRequest {
  scope?: EntityDiscoveryScope;
}

export interface EntityDiscoveryFacet {
  key: string;
  kind: 'type' | 'shortcut';
  label: string;
  terms: readonly string[];
  filter: EntityDiscoveryFilter;
  iconKind: EntityTypeIconKind;
  iconContext?: EntityColorContext;
  count: number;
}

export interface EntityDiscoveryTypes {
  items: EntityDiscoveryFacet[];
  generation: string;
  coverage: EntityDiscoveryCoverage;
}

export function normalizeEntityDiscoveryText(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim();
}

export function entityDiscoveryCategory(
  type: string,
  registryKind: string | null,
  representationKind?: string | null,
  path?: string | null
): EntityDiscoveryCategoryKey {
  const kind = type === 'registry' ? registryKind : type;
  if (
    [
      'sequence',
      'dna_sequence',
      'plasmid',
      'chromosome',
      'rna_sequence',
      'protein',
      'construct',
    ].includes(kind ?? '')
  )
    return 'sequences';
  if (['primer', 'oligo', 'rna_oligo'].includes(kind ?? '')) return 'primers';
  if (kind === 'page' || kind === 'notebook') return 'notebooks';
  if (kind === 'structure' || kind === 'molecular-document') return 'structures';
  if (kind === 'table' || (type === 'file' && isTabularRepresentation(representationKind, path)))
    return 'tables';
  if (kind === 'file' || kind === 'report') return 'files';
  return 'records';
}
