import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type { z } from 'zod';
import { assertToolOperationResult } from '../features/agent-bridge/public/tool-result';
import { portableToolSchema } from '../features/agent-bridge/tool-json-schema';

const provider = new AjvJsonSchemaValidator();
const validators = new WeakMap<z.ZodTypeAny, ReturnType<typeof provider.getValidator>>();

export function assertMcpOutput(schema: z.ZodTypeAny, result: unknown): void {
  let validate = validators.get(schema);
  if (!validate) {
    validate = provider.getValidator(portableToolSchema(schema));
    validators.set(schema, validate);
  }
  const outcome = validate(JSON.parse(JSON.stringify(result)));
  if (!outcome.valid)
    throw new Error(`MCP output contract rejected factory data: ${outcome.errorMessage}`);
}

export function checkedToolFactory<Args extends unknown[], Tool extends { execute?: unknown }>(
  create: (...args: Args) => Tool,
  outputSchema: z.ZodTypeAny
): (...args: Args) => Tool {
  return (...args) => {
    const tool = create(...args);
    if (!('resultContract' in tool) || tool.resultContract !== 'explicit-v1')
      throw new Error('Factory must enforce explicit operation outcomes.');
    const execute = tool.execute;
    if (typeof execute !== 'function') throw new Error('Factory has no executor.');
    return {
      ...tool,
      execute: async (...callArgs: unknown[]) => {
        const result: unknown = await Reflect.apply(execute, tool, callArgs);
        assertToolOperationResult(result);
        if (result.ok) assertMcpOutput(outputSchema, result);
        return result;
      },
    } as Tool;
  };
}
