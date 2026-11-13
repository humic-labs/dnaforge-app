import { scopeKeyFromPageId } from './resolve-owning-root';

export interface OwningRootCandidate {
  path: string;
  pinned?: boolean;
}

export async function resolveOwningRootForPage(input: {
  pageId: string;
  roots: ReadonlyArray<OwningRootCandidate>;
  resolveScope: (root: string) => Promise<string | null>;
}): Promise<string | null> {
  const candidates: string[] = [];
  for (const root of input.roots) {
    if (root.pinned) continue;
    if (!root.path) continue;
    if (!candidates.includes(root.path)) candidates.push(root.path);
  }

  if (candidates.length === 0) return null;

  const scope = scopeKeyFromPageId(input.pageId);

  if (!scope) {
    return candidates.length === 1 ? candidates[0] : null;
  }

  for (const root of candidates) {
    let rootScope: string | null = null;
    try {
      rootScope = await input.resolveScope(root);
    } catch {
      continue;
    }
    if (rootScope && rootScope === scope) return root;
  }

  return null;
}
