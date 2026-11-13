import { z } from 'zod';
import { isAbsolutePathLike } from './path-boundary';

export const APP_FOLLOWING_PROJECT_BINDING = 'app-following';

export const agentProjectScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('app-following') }).strict(),
  z
    .object({
      kind: z.literal('project-roots'),
      roots: z.array(z.string().min(1).max(4096).refine(isAbsolutePathLike)).max(128),
    })
    .strict(),
]);

export type AgentProjectScope = z.infer<typeof agentProjectScopeSchema>;

export interface AuthorizedProjectFolder {
  path: string;
  name: string;
  addedAt: number;
  pinned: boolean;
}

export function legacyProjectScope(binding?: string | null): AgentProjectScope {
  if (binding === undefined || binding === APP_FOLLOWING_PROJECT_BINDING)
    return { kind: 'app-following' };
  try {
    const roots = binding?.startsWith('folder:')
      ? [JSON.parse(binding.slice('folder:'.length))]
      : binding?.startsWith('folders:')
        ? JSON.parse(binding.slice('folders:'.length))
        : [];
    return agentProjectScopeSchema.parse({ kind: 'project-roots', roots });
  } catch {
    return { kind: 'project-roots', roots: [] };
  }
}
