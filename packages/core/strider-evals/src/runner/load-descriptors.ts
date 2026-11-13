import { z } from 'zod';
import { EvalDescriptorSchema, type EvalDescriptor } from '../descriptor/index.ts';

export function loadDescriptor(raw: unknown): EvalDescriptor {
  try {
    return EvalDescriptorSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues
        .map((i) => `  • ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n');
      throw new Error(`Invalid eval descriptor:\n${issues}`);
    }
    throw err;
  }
}
