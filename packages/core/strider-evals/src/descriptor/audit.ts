import { z } from 'zod';
import {
  ActionErrorCodeSchema,
  ActionEffectSchema,
  ActionNameSchema,
  DescriptorMetadataSchema,
  EntityRefSchema,
} from './common.ts';

export const AuditEntryAssertionSchema = z.object({
  actionName: ActionNameSchema,
  status: z.enum(['ok', 'error', 'cancelled']),
  scopeIncludes: z.array(ActionEffectSchema).default([]),
  sessionIdMatchesPattern: z
    .string()
    .default('^session-[a-z0-9-]+$')
    .describe('Regex (string form) the session id must satisfy.'),
  affectedEntities: z.array(EntityRefSchema).default([]),
  expectStateMutated: z.boolean().default(true),
  beforeStateIncludes: z.record(z.string(), z.unknown()).optional(),
  afterStateIncludes: z.record(z.string(), z.unknown()).optional(),
  expectedError: z
    .object({
      code: ActionErrorCodeSchema,
      messageContains: z.string().optional(),
    })
    .optional(),
});
export type AuditEntryAssertion = z.infer<typeof AuditEntryAssertionSchema>;

export const AuditEvalDescriptorSchema = DescriptorMetadataSchema.extend({
  kind: z.literal('audit'),
  actionName: ActionNameSchema,
  input: z.unknown(),
  expectedAudit: AuditEntryAssertionSchema,
});
export type AuditEvalDescriptor = z.infer<typeof AuditEvalDescriptorSchema>;
