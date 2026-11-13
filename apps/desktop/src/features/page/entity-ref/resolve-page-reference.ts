import {
  WORKSPACE_SCOPE_SEP,
  scopedProjectionId,
  stripWorkspaceScope,
} from '../../../shared/workspace-scoped-identity';

export type PageReferenceResolution =
  | { kind: 'resolved'; pageId: string }
  | { kind: 'not-found'; referencedRawId: string }
  | { kind: 'ambiguous'; referencedRawId: string; candidates: string[] };

export function resolvePageReference(input: {
  referencedId: string;
  owningScope: string | null;
  pageIds: readonly string[];
  mountedScopes?: readonly string[] | null;
}): PageReferenceResolution {
  const raw = stripWorkspaceScope(input.referencedId);
  if (!raw) return { kind: 'not-found', referencedRawId: raw };

  const mounted = input.mountedScopes;
  const pageIds =
    mounted && mounted.length > 0
      ? input.pageIds.filter((id) => {
          if (!id.includes(WORKSPACE_SCOPE_SEP)) return true;
          return mounted.includes(id.slice(0, id.indexOf(WORKSPACE_SCOPE_SEP)));
        })
      : input.pageIds;

  if (input.owningScope) {
    const local = scopedProjectionId(input.owningScope, raw);
    if (pageIds.includes(local)) return { kind: 'resolved', pageId: local };
  }

  const matches = pageIds.filter((id) => stripWorkspaceScope(id) === raw);
  if (matches.length === 1) return { kind: 'resolved', pageId: matches[0] };

  if (matches.length > 1) {
    return { kind: 'ambiguous', referencedRawId: raw, candidates: [...matches].sort() };
  }

  return { kind: 'not-found', referencedRawId: raw };
}
