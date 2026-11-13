import { z } from 'zod';
import {
  SIDEBAR_SEARCHABLE_CATALOG_ENTITY_TYPES,
  type MountedCatalogSearchPage,
  type SearchMountedCatalogEntitiesInput,
  type MountedCatalogSearchPosition,
  type MountedCatalogEntitySearchResult,
  type SidebarSearchableCatalogEntityType,
} from './workspace-search-catalog';
import { contentFingerprint } from './content-fingerprint';
import { stripTrailingSep } from './path-boundary';
import { resolveExplicitProjectRoot } from './project-root-selection';

const entityType = z.enum(
  SIDEBAR_SEARCHABLE_CATALOG_ENTITY_TYPES as [
    SidebarSearchableCatalogEntityType,
    ...SidebarSearchableCatalogEntityType[],
  ]
);

export const workspaceSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(1000),
    project: z.string().min(1).max(2000).optional(),
    types: z.array(entityType).min(1).max(17).optional(),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(32_768).optional(),
  })
  .strict();

const cursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.string().regex(/^[a-f0-9]{16}$/),
    position: z
      .object({
        name: z.string().max(10_000),
        updatedAt: z.number().finite(),
        entityId: z.string().min(1).max(1024),
        workspaceRoot: z.string().min(1).max(4096),
      })
      .strict(),
  })
  .strict();

export type WorkspaceSearchRequest = z.input<typeof workspaceSearchSchema>;
export interface WorkspaceSearchContext {
  projects: readonly { name: string; path: string }[];
  openLocalDesignIds?: readonly string[];
}
export interface WorkspaceSearchResult {
  query: string;
  projects: Array<{ name: string; root: string }>;
  results: MountedCatalogEntitySearchResult[];
  nextCursor: string | null;
}

export class WorkspaceSearchError extends Error {
  constructor(
    readonly code: 'SEARCH_PROJECT_UNAVAILABLE' | 'SEARCH_CURSOR_INVALID' | 'SEARCH_SCOPE_CHANGED',
    message: string
  ) {
    super(message);
    this.name = 'WorkspaceSearchError';
  }
}

export async function searchWorkspace(
  request: WorkspaceSearchRequest,
  getContext: () => WorkspaceSearchContext,
  queryPage: (
    input: SearchMountedCatalogEntitiesInput & { after?: MountedCatalogSearchPosition }
  ) => Promise<MountedCatalogSearchPage>,
  signal?: AbortSignal
): Promise<WorkspaceSearchResult> {
  const input = workspaceSearchSchema.parse(request);
  const context = getContext();
  const allProjects = context.projects.map((project) => ({
    ...project,
    path: stripTrailingSep(project.path),
  }));
  const selected = input.project ? resolveExplicitProjectRoot(allProjects, input.project) : null;
  if (input.project && !selected)
    throw new WorkspaceSearchError(
      'SEARCH_PROJECT_UNAVAILABLE',
      'Choose an exact admitted project name or root. Duplicate names need the exact root.'
    );
  const projects = selected ? [selected] : allProjects;
  const scope = searchScope(
    input,
    context,
    projects.map((project) => project.path)
  );
  let after: z.infer<typeof cursorSchema>['position'] | undefined;
  if (input.cursor) {
    try {
      const value = cursorSchema.parse(JSON.parse(decodeURIComponent(input.cursor)));
      if (value.scope !== scope) throw new Error('The search scope changed.');
      after = value.position;
    } catch {
      throw new WorkspaceSearchError(
        'SEARCH_CURSOR_INVALID',
        'This continuation belongs to a different search or project scope. Start a new search.'
      );
    }
  }
  signal?.throwIfAborted();
  const page = await queryPage({
    query: input.query,
    workspaceRoots: projects.map((project) => project.path),
    openLocalDesignIds: context.openLocalDesignIds,
    entityTypes: input.types,
    limit: input.limit,
    after,
  });
  signal?.throwIfAborted();
  if (
    searchScope(
      input,
      getContext(),
      projects.map((project) => project.path)
    ) !== scope
  )
    throw new WorkspaceSearchError(
      'SEARCH_SCOPE_CHANGED',
      'The admitted workspace changed while searching. Search again.'
    );
  return {
    query: input.query,
    projects: projects.map((project) => ({ name: project.name, root: project.path })),
    results: page.results,
    nextCursor: page.nextPosition
      ? encodeURIComponent(JSON.stringify({ version: 1, scope, position: page.nextPosition }))
      : null,
  };
}

function searchScope(
  input: z.output<typeof workspaceSearchSchema>,
  context: WorkspaceSearchContext,
  selectedRoots: readonly string[]
): string {
  return contentFingerprint(
    JSON.stringify({
      query: input.query,
      project: input.project ?? null,
      projects: context.projects
        .map((project) => [stripTrailingSep(project.path), project.name])
        .sort(([left], [right]) => left.localeCompare(right)),
      selectedRoots: [...selectedRoots].sort(),
      types: [...new Set(input.types ?? SIDEBAR_SEARCHABLE_CATALOG_ENTITY_TYPES)].sort(),
      designs: [...new Set(context.openLocalDesignIds ?? [])].sort(),
    })
  );
}
