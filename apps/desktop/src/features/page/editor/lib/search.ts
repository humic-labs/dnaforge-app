import { type ReactNode } from 'react';
import { canonicalEntityIconKind } from '../../../../components/icons/entity-icon-registry';
import { referenceIconFor } from '../../entity-ref/reference-icon';
import { usePageStore } from '../../store';
import { searchPrimerReferencesByName } from '../../../../db/primer-reference-search';
import { listSearchableProjectRoots } from '../../../../db/project-roots';
import {
  PROJECT_REFERENCE_ENTITY_TYPES,
  searchProjectReferencesByName,
  type ProjectReferenceEntityType,
  type ProjectReferenceSearchResult,
} from '../../../../db/project-reference-search';
import { queryLimsRegistrySummaries } from '../../../lims/public/operations';
import { stripWorkspaceScope } from '../../../../shared/workspace-scoped-identity';
import { useWorkspaceStore } from '../../../../stores/workspaceStore';
import { registryKindIconKind, registryKindLabel } from './registry-kind';

export type EntityType = 'page' | 'sequence' | 'primer' | 'registry' | ProjectReferenceEntityType;

export interface Entity {
  id: string;
  type: EntityType;
  name: string;
  path?: string | null;
  contentHash?: string | null;
  localOnly?: boolean;
  objectUuid?: string | null;
  registryKind?: string | null;
  registryId?: string | null;
  kindLabel?: string;
  projectId?: string | null;
  projectRoot?: string | null;
  projectName?: string | null;
  meta?: {
    length?: number;
    circular?: boolean;
    description?: string;
  };
}

export interface SearchResults {
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

const RESULT_LIMIT = 50;
const PROJECT_RESULT_LIMIT = 100;
const REGISTRY_RESULT_LIMIT = 100;

const PROJECT_KIND_LABELS: Readonly<Record<ProjectReferenceEntityType, string>> = {
  design: 'Design',
  structure: 'Structure',
  protein: 'Protein',
  alignment: 'Alignment',
  trace: 'Trace',
  report: 'Report',
  construct: 'Construct',
  sample: 'Sample',
  protocol: 'Protocol',
  protocol_run: 'Protocol run',
  'track-view': 'Track view',
  'molecular-document': 'Molecular document',
  file: 'File',
};

const EMPTY_PROJECT_RESULT: ProjectReferenceSearchResult = { candidates: [], truncated: false };

export async function searchEntities(
  query: string,
  workspaceRoot?: string | null
): Promise<SearchResults> {
  const trimmed = query.trim();
  const lowerQuery = trimmed.toLowerCase();
  const rootsPromise = projectRoots();
  const [pages, sequences, primers, project, registry] = await Promise.all([
    trimmed ? searchPages(lowerQuery) : getRecentPages(RESULT_LIMIT),
    rootsPromise.then((roots) =>
      searchProjectCatalog(query, ['sequence'], roots, workspaceRoot ?? null, RESULT_LIMIT)
    ),
    searchPrimers(query, workspaceRoot ?? null),
    rootsPromise.then((roots) =>
      searchProjectCatalog(
        query,
        PROJECT_REFERENCE_ENTITY_TYPES,
        roots,
        workspaceRoot ?? null,
        PROJECT_RESULT_LIMIT
      )
    ),
    searchRegistry(trimmed),
  ]);
  const projectIds = new Set(
    [...pages, ...sequences.items, ...primers, ...project.items].flatMap((item) => [
      item.id,
      stripWorkspaceScope(item.id),
    ])
  );
  return {
    pages,
    sequences: sequences.items,
    primers,
    project: project.items,
    registry: registry.items.filter(
      (item) => !projectIds.has(item.id) && !projectIds.has(stripWorkspaceScope(item.id))
    ),
    sequencesTruncated: sequences.truncated,
    projectTruncated: project.truncated,
    registryTruncated: registry.truncated,
  };
}

function matchRank(item: Entity, query: string): number {
  if (!query) return 3;
  const name = item.name.toLowerCase();
  if (name === query || item.registryId?.toLowerCase() === query) return 0;
  if (name.startsWith(query) || item.registryId?.toLowerCase().startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  return 3;
}

export function groupSearchResults(results: SearchResults, query: string): EntityGroup[] {
  const lowerQuery = query.trim().toLowerCase();
  const groups = new Map<string, EntityGroup>();
  const add = (
    key: string,
    label: string,
    source: EntityGroup['source'],
    item: Entity,
    partial: boolean
  ) => {
    const group = groups.get(key) ?? { key, label, source, items: [] };
    group.items.push(item);
    if (partial) group.partial = true;
    groups.set(key, group);
  };
  for (const item of results.pages) add('page', 'Notebook', 'project', item, false);
  for (const item of results.sequences)
    add('sequence', 'Sequence', 'project', item, results.sequencesTruncated);
  for (const item of results.primers) add('primer', 'Primer', 'project', item, false);
  for (const item of results.project) {
    const type = item.type as ProjectReferenceEntityType;
    add(type, PROJECT_KIND_LABELS[type] ?? 'File', 'project', item, results.projectTruncated);
  }
  for (const item of results.registry) {
    add(
      `registry:${item.registryKind ?? 'record'}`,
      item.kindLabel ?? registryKindLabel(item.registryKind),
      'registry',
      item,
      results.registryTruncated
    );
  }
  const ranked = [...groups.values()].map((group, order) => {
    const items = group.items
      .map((item, index) => ({ item, index, rank: matchRank(item, lowerQuery) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index);
    return {
      group: { ...group, items: items.map((entry) => entry.item) },
      best: items[0]?.rank ?? 3,
      order,
    };
  });
  return ranked.sort((a, b) => a.best - b.best || a.order - b.order).map((entry) => entry.group);
}

export function getEntityIcon(item: Pick<Entity, 'type' | 'registryKind'>): ReactNode {
  if (item.type === 'registry') return referenceIconFor(registryKindIconKind(item.registryKind));
  return referenceIconFor(canonicalEntityIconKind(item.type) ? item.type : 'file');
}

async function projectRoots(): Promise<string[]> {
  const mounted = useWorkspaceStore.getState().folders.map((folder) => folder.path);
  try {
    return await listSearchableProjectRoots(mounted);
  } catch (error) {
    console.error('Failed to list projects for search:', error);
    return mounted;
  }
}

async function searchPages(query: string): Promise<Entity[]> {
  const { pages } = usePageStore.getState();
  return Object.values(pages)
    .filter((p) => p.title.toLowerCase().includes(query))
    .slice(0, RESULT_LIMIT)
    .map((p) => ({
      id: p.id,
      type: 'page' as const,
      name: p.title,
      path: null,
      contentHash: null,
    }));
}

async function getRecentPages(limit: number): Promise<Entity[]> {
  const { pages } = usePageStore.getState();
  return Object.values(pages)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, limit)
    .map((p) => ({
      id: p.id,
      type: 'page' as const,
      name: p.title,
      path: null,
      contentHash: null,
    }));
}

async function searchPrimers(query: string, workspaceRoot: string | null): Promise<Entity[]> {
  try {
    const rows = await searchPrimerReferencesByName({
      query,
      workspaceRoot,
      limit: RESULT_LIMIT,
    });
    return rows.map((row) => ({
      id: row.primerId,
      type: 'primer' as const,
      name: row.name || `Primer ${row.primerId}`,
      path: row.workspaceRelativePath,
      contentHash: null,
      localOnly: row.localOnly,
    }));
  } catch (error) {
    console.error('Failed to search primers:', error);
    return [];
  }
}

async function searchProjectCatalog(
  query: string,
  entityTypes: Parameters<typeof searchProjectReferencesByName>[0]['entityTypes'],
  workspaceRoots: readonly string[],
  preferredRoot: string | null,
  limit: number
): Promise<{ items: Entity[]; truncated: boolean }> {
  let result = EMPTY_PROJECT_RESULT;
  try {
    result = await searchProjectReferencesByName({
      query,
      entityTypes,
      workspaceRoots,
      preferredRoot,
      limit,
    });
  } catch (error) {
    console.error('Failed to search projects:', error);
  }
  return {
    items: result.candidates.map((row) => ({
      id: row.entityId,
      type: row.entityType,
      name: row.name,
      path: row.workspaceRelativePath,
      contentHash: row.contentHash,
      objectUuid: row.objectUuid,
      localOnly: false,
      projectId: row.projectId,
      projectRoot: row.projectRoot,
      projectName: row.projectName,
    })),
    truncated: result.truncated,
  };
}

async function searchRegistry(query: string): Promise<{ items: Entity[]; truncated: boolean }> {
  try {
    const page = await queryLimsRegistrySummaries({
      ...(query ? { search: query } : {}),
      limit: REGISTRY_RESULT_LIMIT,
    });
    const items = page.summaries
      .filter((summary) => summary.kind !== 'notebook')
      .map((summary) => ({
        id: summary.id,
        type: 'registry' as const,
        name: summary.name || summary.registryId || summary.id,
        path: null,
        contentHash: null,
        objectUuid: null,
        registryKind: summary.kind,
        registryId: summary.registryId,
        kindLabel: summary.schemaDisplayName || registryKindLabel(summary.kind),
      }));
    return { items, truncated: page.totalCount > page.summaries.length };
  } catch (error) {
    console.error('Failed to search the Registry:', error);
    return { items: [], truncated: false };
  }
}
