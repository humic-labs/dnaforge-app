import type { MentionIdShape } from '../../../shared/notebook-reference';
import { isSafeWorkspaceRelativePath } from '../../../shared/path-boundary';

import type { ReferenceContext } from './reference-context';

export type ReferenceResolutionPlan =
  | { kind: 'resolve-path'; absolutePath: string; workspaceRelativePath: string }
  | { kind: 'resolve-sequence-row'; dbId: number }
  | { kind: 'resolve-primer-row'; primerId: string }
  | { kind: 'local-only' }
  | { kind: 'unresolvable'; reason: 'outside-workspace' | 'no-owning-root' | 'malformed' };

export function planReferenceResolution(
  shape: MentionIdShape,
  ctx: ReferenceContext | null
): ReferenceResolutionPlan {
  if (!ctx) return { kind: 'unresolvable', reason: 'no-owning-root' };

  switch (shape.kind) {
    case 'record': {
      const { path, entityId } = shape.ref;
      if (path) return planPath(path, ctx);
      if (entityId) return { kind: 'local-only' };
      return { kind: 'unresolvable', reason: 'malformed' };
    }
    case 'legacy-path':
      return planPath(shape.path, ctx);
    case 'legacy-sequence-row':
      return { kind: 'resolve-sequence-row', dbId: shape.dbId };
    case 'legacy-primer-row':
      return { kind: 'resolve-primer-row', primerId: shape.primerId };
    case 'unresolvable':
      return { kind: 'unresolvable', reason: 'malformed' };
  }
}

function planPath(rawPath: string, ctx: ReferenceContext): ReferenceResolutionPlan {
  if (!isSafeWorkspaceRelativePath(rawPath)) {
    return { kind: 'unresolvable', reason: 'outside-workspace' };
  }

  return {
    kind: 'resolve-path',
    absolutePath: `${stripTrailingSlash(ctx.owningRoot)}/${rawPath}`,
    workspaceRelativePath: rawPath,
  };
}

function stripTrailingSlash(input: string): string {
  return input.endsWith('/') ? input.slice(0, -1) : input;
}
