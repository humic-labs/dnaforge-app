import { z } from 'zod';
import { ActionEvalDescriptorSchema } from './action.ts';
import { StateCoherenceEvalDescriptorSchema } from './state-coherence.ts';
import { AuditEvalDescriptorSchema } from './audit.ts';
import { ProvenanceEvalDescriptorSchema } from './provenance.ts';

export * from './common.ts';
export * from './action.ts';
export * from './state-coherence.ts';
export * from './audit.ts';
export * from './provenance.ts';

export const EvalDescriptorSchema = z.discriminatedUnion('kind', [
  ActionEvalDescriptorSchema,
  StateCoherenceEvalDescriptorSchema,
  AuditEvalDescriptorSchema,
  ProvenanceEvalDescriptorSchema,
]);
export type EvalDescriptor = z.infer<typeof EvalDescriptorSchema>;
