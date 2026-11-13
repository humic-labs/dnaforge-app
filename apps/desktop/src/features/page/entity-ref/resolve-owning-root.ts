import { WORKSPACE_SCOPE_SEP } from '../../../shared/workspace-scoped-identity';
import { findContainingPathBoundary } from '../../../shared/path-boundary';

import type { ReferenceContext } from './reference-context';

export interface OwningRootInput {
  pageId: string;
  pageFilePath: string | null;
  roots: { path: string }[];
}

export function resolveOwningReferenceContext(input: OwningRootInput): ReferenceContext | null {
  const scope = scopeKeyFromPageId(input.pageId);
  if (!scope) return null;

  if (input.pageFilePath) {
    const owner = findContainingPathBoundary(input.roots, input.pageFilePath);
    return owner ? { owningRoot: owner.path, workspaceScopeKey: scope } : null;
  }

  const soleRoot = input.roots.length === 1 ? input.roots[0] : null;
  return soleRoot ? { owningRoot: soleRoot.path, workspaceScopeKey: scope } : null;
}

export function scopeKeyFromPageId(pageId: string): string | null {
  const separatorIndex = pageId.indexOf(WORKSPACE_SCOPE_SEP);
  if (separatorIndex <= 0) return null;
  return pageId.slice(0, separatorIndex);
}
