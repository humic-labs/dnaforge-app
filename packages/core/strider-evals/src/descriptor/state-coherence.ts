import { z } from 'zod';
import {
  ActionErrorCodeSchema,
  ActionNameSchema,
  DescriptorMetadataSchema,
  EntityRefSchema,
} from './common.ts';

export const StaleContextCaseSchema = z.object({
  kind: z.literal('stale-context'),
  expectedRevision: z.number().int().nonnegative(),
  liveRevision: z.number().int().nonnegative(),
  expectedError: z.object({
    code: ActionErrorCodeSchema,
    messageContains: z.string().optional(),
  }),
});
export type StaleContextCase = z.infer<typeof StaleContextCaseSchema>;

export const RevisionBumpCaseSchema = z.object({
  kind: z.literal('revision-bump'),
  initialRevision: z.number().int().nonnegative(),
  expectedRevisionAfter: z.number().int().positive(),
});
export type RevisionBumpCase = z.infer<typeof RevisionBumpCaseSchema>;

export const StateCoherenceCaseSchema = z.discriminatedUnion('kind', [
  StaleContextCaseSchema,
  RevisionBumpCaseSchema,
]);
export type StateCoherenceCase = z.infer<typeof StateCoherenceCaseSchema>;

export const StateCoherenceEvalDescriptorSchema = DescriptorMetadataSchema.extend({
  kind: z.literal('state-coherence'),
  actionName: ActionNameSchema,
  entity: EntityRefSchema,
  input: z.unknown(),
  cases: z.array(StateCoherenceCaseSchema).min(1),
});
export type StateCoherenceEvalDescriptor = z.infer<typeof StateCoherenceEvalDescriptorSchema>;
