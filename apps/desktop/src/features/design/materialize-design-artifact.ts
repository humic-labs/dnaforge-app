import {
  getCurrentCatalogFileForEntity,
  findWorkspaceRootForPath,
  registerContextualCatalogEntity,
} from '../../db/workspace-catalog';
import { resolveCurrentFileByObjectUuid } from '../../db/resolve-by-object-uuid';
import {
  createDesignArtifactFile,
  type DesignArtifactProvenanceSource,
} from '../../db/workspace-artifacts';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import type { WorkspaceFolder } from '../../stores/workspaceStore';
import type { WorkspaceCreationContext } from '../../components/fileBrowserTypes';
import type { SequenceDesign } from './types';
import { loadMocloKitDefinitions } from './moclo-kit-definition';
import { soleWritableProjectRoot } from '../../shared/project-root-selection';

export function selectDesignWorkspaceRoot(
  design: SequenceDesign,
  folders: readonly WorkspaceFolder[]
): string | null {
  const writableFolders = folders.filter((folder) => !folder.pinned);
  const sourceRoot = findDesignSourceWorkspaceRoot(design, writableFolders);
  if (sourceRoot.status === 'ambiguous') return null;
  return sourceRoot.status === 'unique'
    ? sourceRoot.root
    : (soleWritableProjectRoot(folders)?.path ?? null);
}

type ProjectRootResolution =
  | { status: 'none' }
  | { status: 'unique'; root: string }
  | { status: 'ambiguous' };

function projectRootResolution(matches: ReadonlySet<string>): ProjectRootResolution {
  if (matches.size === 0) return { status: 'none' };
  if (matches.size > 1) return { status: 'ambiguous' };
  const root = matches.values().next().value;
  return root ? { status: 'unique', root } : { status: 'none' };
}

function findDesignSourceWorkspaceRoot(
  design: SequenceDesign,
  folders: readonly WorkspaceFolder[]
): ProjectRootResolution {
  const matches = new Set<string>();
  for (const region of design.regions) {
    const matchingRoot = findWorkspaceRootForPath([...folders], region.sourceSequenceId);
    if (matchingRoot) matches.add(matchingRoot);
  }
  return projectRootResolution(matches);
}

export interface MocloWorkspaceResolutionDependencies {
  getCurrentFileForEntity: (entityId: string) => Promise<{ path: string } | null>;
  resolveObject: (objectUuid: string) => Promise<{ absolutePath: string } | null>;
  workspaceHasKit: (workspaceRoot: string, kitId: string, kitRevision: number) => Promise<boolean>;
}

const mocloWorkspaceResolutionDependencies: MocloWorkspaceResolutionDependencies = {
  getCurrentFileForEntity: getCurrentCatalogFileForEntity,
  resolveObject: resolveCurrentFileByObjectUuid,
  workspaceHasKit: async (workspaceRoot, kitId, kitRevision) =>
    (await loadMocloKitDefinitions(workspaceRoot)).some(
      (definition) => definition.id === kitId && definition.revision === kitRevision
    ),
};

async function findDesignSourceWorkspaceRootByIdentity(
  design: SequenceDesign,
  folders: readonly WorkspaceFolder[],
  dependencies: MocloWorkspaceResolutionDependencies
): Promise<ProjectRootResolution> {
  const sourceIds = Array.from(new Set(design.regions.map((region) => region.sourceSequenceId)));
  const resolutions = await Promise.all(
    sourceIds.flatMap((sourceId) => [
      dependencies.getCurrentFileForEntity(sourceId).then((entityFile) => ({
        type: 'entity' as const,
        path: entityFile?.path ?? null,
      })),
      dependencies.resolveObject(sourceId).then((objectFile) => ({
        type: 'object' as const,
        path: objectFile?.absolutePath ?? null,
      })),
    ])
  );
  const matches = new Set<string>();
  for (const resolution of resolutions) {
    if (resolution.type === 'entity') {
      const entityRoot = findWorkspaceRootForPath([...folders], resolution.path);
      if (entityRoot) matches.add(entityRoot);
    } else {
      const objectRoot = findWorkspaceRootForPath([...folders], resolution.path);
      if (objectRoot) matches.add(objectRoot);
    }
  }
  return projectRootResolution(matches);
}

function memoizeWorkspaceResolutionDependencies(
  dependencies: MocloWorkspaceResolutionDependencies
): MocloWorkspaceResolutionDependencies {
  const entityFiles = new Map<string, ReturnType<typeof dependencies.getCurrentFileForEntity>>();
  const objectFiles = new Map<string, ReturnType<typeof dependencies.resolveObject>>();
  return {
    ...dependencies,
    getCurrentFileForEntity: (entityId) => {
      const cached = entityFiles.get(entityId);
      if (cached) return cached;
      const pending = dependencies.getCurrentFileForEntity(entityId);
      entityFiles.set(entityId, pending);
      return pending;
    },
    resolveObject: (objectUuid) => {
      const cached = objectFiles.get(objectUuid);
      if (cached) return cached;
      const pending = dependencies.resolveObject(objectUuid);
      objectFiles.set(objectUuid, pending);
      return pending;
    },
  };
}

export async function resolveMocloFactoryWorkspaceRoot(
  design: SequenceDesign,
  designs: readonly SequenceDesign[],
  folders: readonly WorkspaceFolder[],
  dependencies: MocloWorkspaceResolutionDependencies = mocloWorkspaceResolutionDependencies
): Promise<string | null> {
  const memoizedDependencies = memoizeWorkspaceResolutionDependencies(dependencies);
  const writableFolders = folders.filter((folder) => !folder.pinned);
  const artifact = await memoizedDependencies.getCurrentFileForEntity(design.id);
  if (artifact) return findWorkspaceRootForPath(writableFolders, artifact.path);
  const candidates = writableFolders.length > 0 ? writableFolders : folders;
  const direct = await findDesignSourceWorkspaceRootByIdentity(
    design,
    candidates,
    memoizedDependencies
  );
  if (direct.status === 'ambiguous') return null;
  if (direct.status === 'unique') return direct.root;

  const factory = design.mocloFactory;
  if (!factory) return selectDesignWorkspaceRoot(design, folders);

  const siblings = designs.filter(
    (sibling) =>
      sibling.id !== design.id &&
      sibling.mocloFactory?.runId === factory.runId &&
      sibling.mocloFactory.kitId === factory.kitId &&
      sibling.mocloFactory.recipeId === factory.recipeId
  );
  const siblingResolutions = await Promise.all(
    siblings.map((sibling) =>
      findDesignSourceWorkspaceRootByIdentity(sibling, candidates, memoizedDependencies)
    )
  );
  const siblingRoots = new Set<string>();
  for (const siblingRoot of siblingResolutions) {
    if (siblingRoot.status === 'ambiguous') return null;
    if (siblingRoot.status === 'unique') siblingRoots.add(siblingRoot.root);
  }
  if (siblingRoots.size > 1) return null;
  if (siblingRoots.size === 1) return siblingRoots.values().next().value ?? null;

  const kitChecks = await Promise.allSettled(
    candidates.map(async (folder) => ({
      path: folder.path,
      matches: await dependencies.workspaceHasKit(folder.path, factory.kitId, factory.kitRevision),
    }))
  );
  const kitRoots = kitChecks.flatMap((result) =>
    result.status === 'fulfilled' && result.value.matches ? [result.value.path] : []
  );
  const failed = kitChecks.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  if (kitRoots.length === 1) return kitRoots[0];
  return null;
}

export async function ensureDesignArtifact(input: {
  design: SequenceDesign;
  workspaceRoot: string;
  source: Exclude<DesignArtifactProvenanceSource, 'file-explorer-new-menu'>;
  context?: WorkspaceCreationContext;
}): Promise<string> {
  const existing = await getCurrentCatalogFileForEntity(input.design.id);
  if (existing) return existing.path;

  return withRendererWorkspaceMutation(input.workspaceRoot, async (mutationToken) => {
    const current = await getCurrentCatalogFileForEntity(input.design.id);
    if (current) return current.path;
    const entity = await registerContextualCatalogEntity({
      id: input.design.id,
      type: 'design',
      name: input.design.name,
      locator: `entity://design/${input.design.id}`,
      storageType: 'localStorage',
      workspaceRoot: input.workspaceRoot,
      context: input.context,
      metadata: {
        createdBy: input.source,
        backingStore: 'waypoint-designs',
      },
      mutationToken,
    });
    const artifact = await createDesignArtifactFile({
      entityId: entity.id,
      designId: input.design.id,
      name: input.design.name,
      design: input.design,
      fileName: input.context?.artifactFileName,
      workspaceRoot: input.workspaceRoot,
      context: input.context,
      provenanceSource: input.source,
      mutationToken,
    });
    if (!artifact) throw new Error('Could not save this assembly in the managed project.');
    return artifact.path;
  });
}
