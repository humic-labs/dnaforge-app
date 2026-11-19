import { z } from 'zod';
import { platform } from '../../../platform';
import type { AgentProjectScope } from '../../../shared/agent-project-scope';
import type { EntityDiscoveryScope } from '../../../shared/entity-discovery';
import {
  entityDiscoveryRequestSchema,
  entityDiscoveryResolveRequestSchema,
  entityDiscoveryPageSchema,
  entityDiscoveryResolutionSchema,
  entityDiscoveryTypesRequestSchema,
  entityDiscoveryTypesSchema,
} from '../../../shared/entity-discovery-schema';
import { stripTrailingSep } from '../../../shared/path-boundary';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';

export const entityDiscoveryToolSchema = z.discriminatedUnion('operation', [
  entityDiscoveryRequestSchema.extend({ operation: z.literal('search') }),
  entityDiscoveryResolveRequestSchema.extend({ operation: z.literal('resolve') }),
  entityDiscoveryTypesRequestSchema.extend({ operation: z.literal('types') }),
]);

export const entityDiscoveryToolOutputSchema = z.union([
  entityDiscoveryPageSchema.extend({ ok: z.literal(true), operation: z.literal('search') }),
  entityDiscoveryResolutionSchema.extend({ ok: z.literal(true), operation: z.literal('resolve') }),
  entityDiscoveryTypesSchema.extend({ ok: z.literal(true), operation: z.literal('types') }),
]);

function authorizedScope(
  scope: EntityDiscoveryScope | undefined,
  authorization: AgentProjectScope
): EntityDiscoveryScope | undefined {
  if (authorization.kind === 'app-following') return scope;
  const allowed = authorization.roots.map(stripTrailingSep);
  const requested = scope?.projectRoots?.map(stripTrailingSep);
  return {
    ...scope,
    projectRoots: requested ? allowed.filter((root) => requested.includes(root)) : allowed,
  };
}

export function createEntityDiscoveryTool(authorization: AgentProjectScope) {
  return resultTool({
    description:
      'Search and resolve linkable entities through the same native database owner used by notebook pickers. Search returns a continuation cursor; refresh if the catalog generation changes. Resolve uses exact IDs and reports unavailable records without name substitution.',
    inputSchema: entityDiscoveryToolSchema,
    execute: async (input: z.infer<typeof entityDiscoveryToolSchema>) => {
      try {
        const { operation, ...request } = input;
        const scope = authorizedScope(request.scope, authorization);
        if (operation === 'search') {
          const parsed = entityDiscoveryRequestSchema.parse(request);
          return toolSuccess({
            operation,
            ...(await platform().entityDiscovery.search({ ...parsed, scope })),
          });
        }
        if (operation === 'types')
          return toolSuccess({ operation, ...(await platform().entityDiscovery.types({ scope })) });
        const parsed = entityDiscoveryResolveRequestSchema.parse(request);
        return toolSuccess({
          operation,
          ...(await platform().entityDiscovery.resolve({ ...parsed, scope })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code =
          message.match(/ENTITY_DISCOVERY_(?:CURSOR_INVALID|REFRESH_REQUIRED)/)?.[0] ??
          'ENTITY_DISCOVERY_FAILED';
        return toolFailure({
          code,
          error: message,
          retriable: code === 'ENTITY_DISCOVERY_REFRESH_REQUIRED',
          stateChanged: false,
          partialEffects: [],
        });
      }
    },
  });
}
