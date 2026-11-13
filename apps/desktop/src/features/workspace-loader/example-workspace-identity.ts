import {
  STANDARD_SAMPLE_WORKSPACE_MANIFEST,
  isBundledSampleWorkspaceOriginPath,
} from '../../shared/sample-workspace-ipc';

export function isExampleWorkspaceEntry(entry: { originPath: string | null }): boolean {
  return isBundledSampleWorkspaceOriginPath(entry.originPath);
}

export interface ExampleMountDecisionInput {
  materialized: boolean;

  active: boolean;

  dismissed: boolean;
}

export function shouldMountExampleWorkspace(input: ExampleMountDecisionInput): boolean {
  if (input.active) return true;
  if (input.dismissed) return false;
  if (input.materialized && !input.active) return false;
  return true;
}

interface ExampleWorkspaceMountCandidate {
  repoUuid: string | null;
  repoPath: string;
  originPath: string | null;
  lastOpenedAt: number | null;
}

export function selectExampleWorkspaceMount<T extends ExampleWorkspaceMountCandidate>(
  entries: readonly T[]
): { selected: T | null; superseded: T[] } {
  const candidates = entries.filter((entry) => entry.repoUuid && isExampleWorkspaceEntry(entry));
  if (candidates.length === 0) return { selected: null, superseded: [] };

  const currentVersionSegment =
    `/sample workspaces/${STANDARD_SAMPLE_WORKSPACE_MANIFEST.templateId}/` +
    `${STANDARD_SAMPLE_WORKSPACE_MANIFEST.version}/`;
  const newestFirst = (a: T, b: T) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0);
  const currentVersionCandidates = candidates
    .filter((candidate) =>
      candidate.originPath?.replace(/\\/g, '/').toLowerCase().includes(currentVersionSegment)
    )
    .sort(newestFirst);
  const selected = currentVersionCandidates[0] ?? null;

  return {
    selected,
    superseded: selected
      ? candidates.filter((candidate) => candidate.repoUuid !== selected.repoUuid)
      : [...candidates].sort(newestFirst),
  };
}

export async function consolidateExampleWorkspaceVersions<
  T extends { repoUuid: string | null },
  L extends { active: readonly T[] },
>(input: {
  superseded: readonly T[];
  openCurrent: () => Promise<boolean>;
  archive: (repoUuid: string) => Promise<unknown>;
  loadLibrary: () => Promise<L>;
}): Promise<{ opened: boolean; library: L | null }> {
  const opened = await input.openCurrent();
  if (!opened) return { opened: false, library: null };

  await Promise.all(
    input.superseded.map((workspace) => {
      if (!workspace.repoUuid)
        throw new Error('The Samples project repository identity is missing.');
      return input.archive(workspace.repoUuid);
    })
  );
  const library = await input.loadLibrary();
  const activeIds = new Set(library.active.map((workspace) => workspace.repoUuid));
  const stillActive = input.superseded.filter((workspace) => activeIds.has(workspace.repoUuid));
  if (stillActive.length > 0) {
    throw new Error(
      `Could not archive ${stillActive.length} superseded Samples project${stillActive.length === 1 ? '' : 's'}`
    );
  }
  return { opened: true, library };
}
