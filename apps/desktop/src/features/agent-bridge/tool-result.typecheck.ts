import { z } from 'zod';
import { resultTool, toolSuccess } from './tool-result';

function checkFactoryResultTypes() {
  resultTool({
    inputSchema: z.object({}),
    // @ts-expect-error A feature-specific refusal must declare the shared outcome.
    execute: async () => ({ imported: false, error: 'Exists' }),
  });
  resultTool({
    inputSchema: z.object({}),
    // @ts-expect-error A failure must carry code, retryability, and effects.
    execute: async () => ({ ok: false as const, error: 'Exists' }),
  });
  resultTool({
    inputSchema: z.object({}),
    execute: async () => toolSuccess({ entries: [], count: 0 }),
  });
}

void checkFactoryResultTypes;
