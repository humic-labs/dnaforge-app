import type { InlineReferenceTargetType } from '../../../../shared/inline-reference-ipc';
import type { WorkspaceFolder } from '../../../../stores/workspaceStore';
import type { InlineReferenceDeclaration, InlineTextDocument } from './types';

type WorkspaceDeclaration = Extract<InlineReferenceDeclaration, { kind: 'workspace-path' }>;

type WorkspaceRoot = Pick<WorkspaceFolder, 'name' | 'path'>;

interface WorkspaceTargetResolver {
  (request: {
    roots: WorkspaceRoot[];
    root: string;
    segments: string[];
    targetKind: 'workspace';
  }): Promise<{ ok: true; targetType: InlineReferenceTargetType } | { ok: false }>;
}

export function persistedWorkspaceTargetKey(
  declaration: WorkspaceDeclaration,
  roots: readonly WorkspaceRoot[]
): string {
  const mountedPaths = roots
    .filter((root) => root.name === declaration.root)
    .map((root) => root.path)
    .sort();
  return JSON.stringify([declaration.root, mountedPaths, ...declaration.segments]);
}

function unresolvedWorkspaceTargetKeys(
  documents: Iterable<InlineTextDocument>,
  roots: readonly WorkspaceRoot[]
): string[] {
  const keys = new Set<string>();
  for (const document of documents) {
    for (const part of document.parts) {
      if (
        part.declaration.kind !== 'workspace-path' ||
        part.state.status !== 'resolved' ||
        part.state.targetType
      ) {
        continue;
      }
      keys.add(persistedWorkspaceTargetKey(part.declaration, roots));
    }
  }
  return [...keys].sort();
}

export function persistedWorkspaceTargetResolutionKey(
  documents: Iterable<InlineTextDocument>,
  roots: readonly WorkspaceRoot[]
): string {
  return JSON.stringify(unresolvedWorkspaceTargetKeys(documents, roots));
}

export function persistedWorkspaceTargetTypesEqual(
  current: ReadonlyMap<string, InlineReferenceTargetType>,
  next: ReadonlyMap<string, InlineReferenceTargetType>
): boolean {
  if (current.size !== next.size) return false;
  for (const [key, targetType] of current) {
    if (next.get(key) !== targetType) return false;
  }
  return true;
}

export async function resolvePersistedWorkspaceTargetTypes(
  documents: Iterable<InlineTextDocument>,
  roots: readonly WorkspaceRoot[],
  resolveTarget: WorkspaceTargetResolver
): Promise<Map<string, InlineReferenceTargetType>> {
  const declarations = new Map<string, WorkspaceDeclaration>();
  for (const document of documents) {
    for (const part of document.parts) {
      if (
        part.declaration.kind !== 'workspace-path' ||
        part.state.status !== 'resolved' ||
        part.state.targetType
      ) {
        continue;
      }
      declarations.set(persistedWorkspaceTargetKey(part.declaration, roots), part.declaration);
    }
  }

  const resolved = await Promise.all(
    [...declarations].map(async ([key, declaration]) => {
      try {
        const result = await resolveTarget({
          roots: roots.map((root) => ({ name: root.name, path: root.path })),
          root: declaration.root,
          segments: [...declaration.segments],
          targetKind: 'workspace',
        });
        return result.ok ? ([key, result.targetType] as const) : null;
      } catch {
        return null;
      }
    })
  );

  return new Map(resolved.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
}
