import { z } from 'zod';
import { parseWorkspaceIdentity } from '@waypoint/domain-services';
import { parseOperationId } from '@waypoint/workspace-revisions';

export const scientificDesignSetupRequestSchema = z
  .object({
    workspaceRoot: z.string().min(1),
    request: z
      .object({
        workspace: z.string().transform((value) => parseWorkspaceIdentity(value)),
        operationId: z.string().refine((value) => parseOperationId(value).ok),
        expectedHead: z.null(),
        source: z.object({ kind: z.literal('initialize-empty-namespace') }).strict(),
      })
      .strict(),
    mutationToken: z.string().min(1).optional(),
  })
  .strict();

export type ScientificDesignSetupRequest = z.infer<typeof scientificDesignSetupRequestSchema>;
