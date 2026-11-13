import { findWorkspaceRootForPath } from '../../db/workspace-catalog';
import { platform } from '../../platform';
import {
  isAbsolutePath,
  resolveWorkspaceEntityPath,
  workspacePathCandidates,
} from '../../shared/resolve-entity-path';
import { writePrimerIdtOrderClipboard } from '../sequence-clipboard/public/primer-clipboard';
import type { BoundPrimer, Primer } from '../primers/public/types';

export function boundPrimerForDisplay(
  display: { id: string; sourcePrimerId?: string },
  primers: readonly BoundPrimer[]
): BoundPrimer | null {
  const exact = primers.find((record) => record.binding.id === display.id);
  if (exact) return exact;
  const matches = primers.filter((record) => record.id === display.sourcePrimerId);
  return matches.length === 1 ? matches[0] : null;
}

export async function copyPrimerRecord(primer: {
  bases: string;
  modifications?: string | null;
}): Promise<void> {
  const notation = primer.modifications ?? primer.bases;
  await writePrimerIdtOrderClipboard(primer.bases, notation);
}

export interface PrimerArtifactLocation {
  artifactPath: string;
  workspaceRoot: string;
  destinationPath: string;
}

export async function primerArtifactLocation(
  record: Primer,
  workspaceFolders: Parameters<typeof resolveWorkspaceEntityPath>[1] &
    Parameters<typeof findWorkspaceRootForPath>[0]
): Promise<PrimerArtifactLocation | null> {
  const artifactLocator = record.originDetails?.artifactPath;
  if (typeof artifactLocator !== 'string') return null;
  let artifactPath = resolveWorkspaceEntityPath(artifactLocator, workspaceFolders);
  if (!artifactPath && !isAbsolutePath(artifactLocator)) {
    const present: string[] = [];
    const roots = workspaceFolders.map((folder) => ({ path: folder.path }));
    for (const candidate of workspacePathCandidates(artifactLocator, roots)) {
      if (
        await platform()
          .fs.exists(candidate)
          .catch(() => false)
      )
        present.push(candidate);
    }
    if (present.length === 1) artifactPath = present[0];
  }
  const workspaceRoot = artifactPath
    ? findWorkspaceRootForPath(workspaceFolders, artifactPath)
    : null;
  if (!artifactPath || !workspaceRoot) return null;
  const lastSeparator = Math.max(artifactPath.lastIndexOf('/'), artifactPath.lastIndexOf('\\'));
  return {
    artifactPath,
    workspaceRoot,
    destinationPath: lastSeparator > 0 ? artifactPath.slice(0, lastSeparator) : workspaceRoot,
  };
}
