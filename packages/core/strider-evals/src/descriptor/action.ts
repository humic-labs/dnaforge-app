import { z } from 'zod';
import {
  ActionClassSchema,
  ActionEffectSchema,
  ActionErrorCodeSchema,
  ActionNameSchema,
  ActionRuntimeSchema,
  DescriptorMetadataSchema,
} from './common.ts';

export const ActionEvalAssertionsSchema = z
  .object({
    success: z
      .object({
        resultEquals: z.unknown().optional(),
      })
      .optional(),
    failure: z
      .object({
        code: ActionErrorCodeSchema,
        messageContains: z.string().optional(),
        retriable: z.boolean().optional(),
      })
      .optional(),
  })
  .refine(
    (v) => {
      const branches = [v.success, v.failure].filter(Boolean).length;
      return branches === 1;
    },
    {
      message:
        'ActionEval requires exactly one of `assertions.success` or `.failure`. The runner asserts the first branch it finds and silently ignores siblings.',
    }
  );
export type ActionEvalAssertions = z.infer<typeof ActionEvalAssertionsSchema>;

export const ActionEvalDescriptorSchema = DescriptorMetadataSchema.extend({
  kind: z.literal('action'),
  actionName: ActionNameSchema,
  runtime: ActionRuntimeSchema,
  effects: z.array(ActionEffectSchema).min(1),
  actionClass: ActionClassSchema.optional(),
  input: z.unknown(),
  assertions: ActionEvalAssertionsSchema,
});
export type ActionEvalDescriptor = z.infer<typeof ActionEvalDescriptorSchema>;
