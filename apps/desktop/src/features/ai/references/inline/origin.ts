import type { DBEntityReference } from '../../../../db/entity-references';
import type { WorkspaceFolder } from '../../../../stores/workspaceStore';

type WorkspaceRoot = Pick<WorkspaceFolder, 'name' | 'path'>;

export interface GitLocatorParts {
  root: string;
  segments: string[];
}

export type InlineReferenceOriginResult =
  | { ok: true; rootPath: string; recovered: boolean }
  | { ok: false; code: 'origin-unrecoverable' };

export function gitLocatorParts(locator: string): GitLocatorParts | null {
  if (!locator.startsWith('git://')) return null;
  const locatorPath = locator.slice('git://'.length);
  const firstSlash = locatorPath.indexOf('/');
  if (firstSlash <= 0 || firstSlash === locatorPath.length - 1) return null;
  const root = locatorPath.slice(0, firstSlash);
  const segments = locatorPath.slice(firstSlash + 1).split('/');
  if (
    !root ||
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\')
    )
  ) {
    return null;
  }
  return { root, segments };
}

function unique(values: readonly string[]): string | null {
  const candidates = [...new Set(values)];
  return candidates.length === 1 ? candidates[0] : null;
}

function parseFolderScope(scope: string | null): string[] | null {
  if (!scope?.startsWith('folders:')) return null;
  try {
    const parsed = JSON.parse(scope.slice('folders:'.length)) as unknown;
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string' || !value)) {
      return null;
    }
    return [...new Set(parsed)];
  } catch {
    return null;
  }
}

function isWorkspaceFileScope(scope: string | null): boolean {
  return Boolean(scope && (scope.startsWith('file:') || scope.endsWith('.waypoint-workspace')));
}

export function workspaceRootPathForGitLocator(
  locator: string,
  roots: readonly WorkspaceRoot[]
): string | null {
  const parts = gitLocatorParts(locator);
  if (!parts) return null;
  return unique(roots.filter((root) => root.name === parts.root).map((root) => root.path));
}

export async function resolveInlineReferenceOrigin(input: {
  reference: Pick<DBEntityReference, 'locator' | 'workspace_root_path' | 'workspace_scope'>;
  conversationWorkspacePath: string | null;
  validateCandidate: (rootPath: string) => Promise<boolean>;
}): Promise<InlineReferenceOriginResult> {
  if (input.reference.workspace_root_path) {
    return { ok: true, rootPath: input.reference.workspace_root_path, recovered: false };
  }

  const locator = gitLocatorParts(input.reference.locator);
  if (!locator) return { ok: false, code: 'origin-unrecoverable' };

  const folderScopePaths = parseFolderScope(input.reference.workspace_scope);
  const candidates = folderScopePaths
    ? [...new Set(folderScopePaths)]
    : isWorkspaceFileScope(input.reference.workspace_scope) && input.conversationWorkspacePath
      ? [input.conversationWorkspacePath]
      : [];

  if (candidates.length === 1) {
    return { ok: true, rootPath: candidates[0], recovered: true };
  }

  const validated = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        return (await input.validateCandidate(candidate)) ? candidate : null;
      } catch {
        return null;
      }
    })
  );
  const winner = unique(validated.filter((candidate): candidate is string => candidate !== null));
  return winner
    ? { ok: true, rootPath: winner, recovered: true }
    : { ok: false, code: 'origin-unrecoverable' };
}
