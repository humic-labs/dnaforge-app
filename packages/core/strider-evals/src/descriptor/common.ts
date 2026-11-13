import { z } from 'zod';
import { isValidActionName } from '@waypoint/agent-tools';

export const ActionNameSchema = z.string().refine(isValidActionName, {
  message:
    'actionName must match @waypoint/agent-tools naming: domain.verb with optional _vN (N>=2). domain=[a-z][a-z0-9]*, verb=[a-z][a-zA-Z0-9]*.',
});

export const EvalKindSchema = z.enum(['action', 'state-coherence', 'audit', 'provenance']);
export type EvalKind = z.infer<typeof EvalKindSchema>;

export const EvalModeSchema = z.enum(['mock-llm', 'real-llm', 'dev-loop']);
export type EvalMode = z.infer<typeof EvalModeSchema>;

export const ActionRuntimeSchema = z.enum(['renderer', 'sidecar']);
export type ActionRuntime = z.infer<typeof ActionRuntimeSchema>;

export const ActionEffectSchema = z.enum(['read-only', 'mutating', 'ui-bound']);
export type ActionEffect = z.infer<typeof ActionEffectSchema>;

export const ActionClassSchema = z.enum(['read', 'modify', 'schema-change', 'external']);
export type ActionClass = z.infer<typeof ActionClassSchema>;

export const ActionErrorCodeSchema = z.enum([
  'BAD_INPUT',
  'STALE_STATE',
  'SCOPE_DENIED',
  'EXECUTION_FAILED',
  'NOT_IMPLEMENTED',
]);
export type ActionErrorCode = z.infer<typeof ActionErrorCodeSchema>;

export const EntityKindSchema = z.enum(['sequence', 'design', 'page', 'structure', 'workspace']);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export const EntityRefSchema = z.object({
  kind: EntityKindSchema,
  id: z.string().min(1),
});
export type EntityRef = z.infer<typeof EntityRefSchema>;

export const DescriptorMetadataSchema = z.object({
  id: z.string().min(1, 'descriptor id required'),
  kind: EvalKindSchema,
  description: z.string().min(1),
  mode: EvalModeSchema.default('mock-llm'),
  tags: z.array(z.string()).default([]),
  knownIssue: z.string().optional(),
  ticket: z
    .string()
    .regex(/^[A-Z][A-Z0-9]*-\d+$/, 'ticket must be a PROJECT-NNN reference')
    .optional(),
});
export type DescriptorMetadata = z.infer<typeof DescriptorMetadataSchema>;
