import { parsePrimerArtifact } from '@waypoint/scientific-artifacts/shared/primers/primer-artifact';

export * from '@waypoint/scientific-artifacts/shared/primers/primer-artifact';

export function readBoundPrimerArtifact(content: string, relativePath: string, entityId?: string) {
  const artifact = parsePrimerArtifact(content);
  if (
    artifact.file.workspaceRelativePath !== relativePath ||
    (entityId !== undefined &&
      (artifact.id !== entityId || artifact.registry.entityId !== entityId))
  )
    throw new Error('Primer artifact identity does not match its project file path.');
  return artifact;
}
