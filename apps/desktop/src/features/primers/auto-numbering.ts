import { platform } from '../../platform';

export async function generateCatalogNumber(
  workspaceId: number,
  workspaceRoot?: string,
  mutationToken?: string
): Promise<string> {
  if (!workspaceRoot && !mutationToken) {
    return platform().db.allocatePrimerCatalogNumber(workspaceId);
  }
  return platform().db.allocatePrimerCatalogNumber(workspaceId, workspaceRoot, mutationToken);
}
