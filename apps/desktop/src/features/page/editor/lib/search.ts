import { type ReactNode } from 'react';
import {
  namedEntityTypePresentation,
  resolveNamedEntityType,
} from '@waypoint/scientific-artifacts/shared/entity-types';
import { referenceIconPresentation } from '../../../../components/icons/entity-icon-registry';
import { referenceIconFor } from '../../entity-ref/reference-icon';
import { useEntityViewHistory } from '../../../../services/recent-entity-views';
import { platform } from '../../../../platform';
import {
  type EntityDescriptor,
  type EntityDiscoveryFacet,
  type EntityDiscoveryFilter,
  type EntityDiscoveryScope,
  type EntityDiscoveryPage,
} from '../../../../shared/entity-discovery';

export type EntityType = EntityDescriptor['type'];
export type EntityLinkFilter = EntityDiscoveryFilter;

export interface EntityLinkCategory {
  key: string;
  label: string;
  terms: readonly string[];
  filter: EntityLinkFilter;
  iconKind: string;
  iconContext?: EntityDiscoveryFacet['iconContext'];
  browse?: boolean;
}

export type Entity = Pick<EntityDescriptor, 'id' | 'type' | 'name'> & Partial<EntityDescriptor>;

export interface SearchResults {
  items: Entity[];
  nextCursor: string | null;
  generation: string;
  coverage: EntityDiscoveryPage['coverage'];
  pages: Entity[];
  sequences: Entity[];
  primers: Entity[];
  project: Entity[];
  registry: Entity[];
  sequencesTruncated: boolean;
  projectTruncated: boolean;
  registryTruncated: boolean;
}

export interface EntityGroup {
  key: string;
  label: string;
  source: 'project' | 'registry';
  items: Entity[];
  partial?: boolean;
}

export async function discoverEntityLinkTypes(
  scope?: EntityDiscoveryScope
): Promise<EntityLinkCategory[]> {
  const result = await platform().entityDiscovery.types(scope ? { scope } : {});
  return result.items.map((facet) => ({ ...facet, browse: facet.kind === 'type' }));
}

export function matchingEntityLinkCategories(
  categories: readonly EntityLinkCategory[],
  query: string
): EntityLinkCategory[] {
  const normalize = (term: string) =>
    term.normalize('NFKC').replace(/[-_]+/g, ' ').trim().toLocaleLowerCase();
  const normalized = normalize(query);
  const terms = (category: EntityLinkCategory) =>
    [category.label, ...category.terms].flatMap((term) => {
      const value = normalize(term);
      return [value, `${value}s`];
    });
  const exact = normalized
    ? categories.filter(
        (category) => category.browse === false && terms(category).includes(normalized)
      )
    : [];
  if (exact.length) return exact;
  return categories.filter((category) => terms(category).some((term) => term.includes(normalized)));
}

export function entityLocationLabel(entity: Pick<Entity, 'projectName'>): string | null {
  return entity.projectName?.trim() || null;
}

export async function searchEntities(
  query: string,
  workspaceRoot?: string | null,
  filter?: EntityLinkFilter | null,
  options: { cursor?: string; scope?: EntityDiscoveryScope; limit?: number } = {}
): Promise<SearchResults> {
  const page = await platform().entityDiscovery.search({
    query,
    ...(workspaceRoot ? { preferredProjectRoot: workspaceRoot } : {}),
    ...(filter ? { filter } : {}),
    ...options,
  });
  const items = page.items;
  return {
    ...page,
    items,
    pages: items.filter((item) => item.type === 'page'),
    sequences: items.filter((item) => item.type === 'sequence'),
    primers: items.filter((item) => item.type === 'primer'),
    project: items.filter(
      (item) =>
        item.type !== 'page' &&
        item.type !== 'sequence' &&
        item.type !== 'primer' &&
        item.type !== 'registry'
    ),
    registry: items.filter((item) => item.type === 'registry'),
    sequencesTruncated: Boolean(page.nextCursor),
    projectTruncated: Boolean(page.nextCursor),
    registryTruncated: Boolean(page.nextCursor),
  };
}

export async function resolveEntityLinks(ids: readonly string[], scope?: EntityDiscoveryScope) {
  const result = await platform().entityDiscovery.resolve({ ids, ...(scope ? { scope } : {}) });
  return result.items;
}

export async function getRecentlyViewedEntityGroups(
  query = '',
  scope?: EntityDiscoveryScope
): Promise<EntityGroup[]> {
  const views = useEntityViewHistory.getState().views;
  if (!views.length) return [];
  const resolved = await resolveEntityLinks(
    views.map((view) => view.entityId),
    scope
  );
  const normalized = query.normalize('NFKC').trim().toLocaleLowerCase();
  const items = resolved.flatMap((item) =>
    item.status === 'available' &&
    (!normalized || item.entity.name.normalize('NFKC').toLocaleLowerCase().includes(normalized))
      ? [item.entity]
      : []
  );
  return items.length
    ? [{ key: 'recently-viewed', label: 'Recently viewed', source: 'project', items }]
    : [];
}

export function groupSearchResults(
  results: Pick<SearchResults, 'items'>,
  _query: string
): EntityGroup[] {
  const groups: EntityGroup[] = [];
  for (const item of results.items) {
    const source = item.type === 'registry' ? 'registry' : 'project';
    const label = item.kindLabel ?? fallbackPresentation(item).kindLabel;
    const previous = groups.at(-1);
    if (
      previous?.label === label &&
      previous.source === source &&
      previous.items[0].namedTypeKey === item.namedTypeKey
    )
      previous.items.push(item);
    else groups.push({ key: item.id, label, source, items: [item] });
  }
  return groups;
}

function fallbackPresentation(item: Pick<Entity, 'type' | 'registryKind'>) {
  return namedEntityTypePresentation(resolveNamedEntityType(item));
}

export function getEntityIcon(
  item: Pick<Entity, 'type' | 'registryKind' | 'iconKind' | 'path' | 'namedTypeKey' | 'iconContext'>
): ReactNode {
  const presentation = referenceIconPresentation({
    ...item,
    iconKind: item.iconKind ?? fallbackPresentation(item).iconKind,
  });
  return referenceIconFor(presentation.kind, 'w-4 h-4', presentation.context);
}

export function getEntityCategoryIcon(category: EntityLinkCategory): ReactNode {
  const namedType = category.filter.namedTypeKey;
  const kind = namedType?.startsWith('type:')
    ? namedType.slice(5)
    : category.filter.registryKinds?.[0];
  return referenceIconFor(category.iconKind, 'w-4 h-4', { kind, ...category.iconContext });
}
