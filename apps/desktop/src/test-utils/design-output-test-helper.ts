import type { z } from 'zod';
import { assertToolOperationResult } from '../features/agent-bridge/public/tool-result';
import { assertMcpOutput } from './mcp-output-test-helper';
import { execOpts } from '../features/ai/tools/test-helpers';

export async function execDesignContract<T>(
  schema: z.ZodTypeAny,
  tool: { execute?: (args: unknown, opts: typeof execOpts) => unknown },
  args: unknown,
  opts = execOpts
): Promise<T> {
  if (!tool.execute) throw new Error('Tool has no execute handler.');
  const result = await tool.execute(args, opts);
  assertToolOperationResult(result);
  if (result.ok) assertMcpOutput(schema, result);
  return result as T;
}
