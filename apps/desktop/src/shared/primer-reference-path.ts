import { isSafeWorkspaceRelativePath, stripTrailingSep } from './path-boundary';
export function resolvePortablePrimerReferencePath(
  row: { workspace_path: string | null; origin_details: string | null },
  owningRoot: string | null
): string | null {
  if (!owningRoot) return null;

  if (!row.workspace_path || stripTrailingSep(row.workspace_path) !== owningRoot) return null;

  const artifactPath = readArtifactPath(row.origin_details);
  if (!artifactPath) return null;

  if (!isSafeWorkspaceRelativePath(artifactPath)) return null;

  return artifactPath;
}

export function readOriginDetails(originDetails: string | null): Record<string, unknown> | null {
  if (!originDetails) return null;
  try {
    const parsed = JSON.parse(originDetails) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readArtifactPath(originDetails: string | null): string | null {
  const parsed = readOriginDetails(originDetails);
  return typeof parsed?.artifactPath === 'string' && parsed.artifactPath
    ? parsed.artifactPath
    : null;
}
