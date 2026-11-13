import type {
  RelocateEntityFileInput,
  RelocateEntityFileResult,
} from '../shared/workspace-relocate-types';

export function createHostedFileRelocator(dependencies: {
  rename: (oldPath: string, newPath: string) => Promise<void>;
  rebindCatalogFiles: (
    input: Pick<RelocateEntityFileInput, 'oldPath' | 'newPath' | 'workspaceRoot' | 'actor'>
  ) => Promise<{ updated: number }>;
}) {
  return async function relocateHostedEntityFile(
    request: RelocateEntityFileInput
  ): Promise<RelocateEntityFileResult> {
    if (request.oldPath === request.newPath) {
      return hostedRelocateResult(request.newPath, 0);
    }
    await dependencies.rename(request.oldPath, request.newPath);
    const rebound = await dependencies.rebindCatalogFiles({
      oldPath: request.oldPath,
      newPath: request.newPath,
      workspaceRoot: request.workspaceRoot,
      actor: request.actor,
    });
    return hostedRelocateResult(request.newPath, rebound.updated);
  };
}

function hostedRelocateResult(newPath: string, catalogUpdated: number): RelocateEntityFileResult {
  return {
    newPath,
    counts: {
      catalog: { updated: catalogUpdated },
      indexed: { indexedFilesMoved: 0, staleIndexedFilesMerged: 0, primerBindingsRepointed: 0 },
      lims: { rebasedEntityIds: [], workspaceIds: [] },
    },
  };
}
