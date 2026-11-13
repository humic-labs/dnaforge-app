import { z } from 'zod';
import { MAX_HOSTED_WHOLE_REQUEST_BYTES } from './wire.js';

export const HOSTED_TOOL_DISCOVERY_NAME = 'dnaforge_discover_tools';
export const HOSTED_TOOL_DISPATCH_NAME = 'dnaforge_execute_tool';

export const HOSTED_CODEX_RESERVED_TOOLS = Object.freeze([
  'NotebookEdit',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'operations.alignment-coverage-preparation.start',
  'operations.alignment-index-preparation.start',
  'operations.track-registration.start',
  'operations.variant-source-preparation.start',
  'get_sequence_genetic_code',
  'set_sequence_genetic_code',
  'add_indexed_bigwig_url',
  'import_genome_sources',
  'set_indexed_current_view',
  'compute.listProviders',
  'compute.listTools',
  'compute.getSchema',
  'compute.validate',
  'compute.estimate',
  'compute.submit',
  'compute.status',
  'compute.cancel',
  'compute.importResult',
  'get_external_agent_access',
  'configure_external_agent_access',
  'close_tab',
]);

export const HostedToolDiscoveryInputSchema = z
  .object({
    query: z.string().max(1_024),
    offset: z.number().int().nonnegative().max(1_000_000).optional(),
    limit: z.number().int().min(1).max(8).optional(),
  })
  .strict();

const HostedToolDispatchInputSchema = z
  .object({
    name: z.string().min(1).max(128),
    arguments: z.string().max(MAX_HOSTED_WHOLE_REQUEST_BYTES),
  })
  .strict();

export const HOSTED_TOOL_TRANSPORT_DEFINITIONS = Object.freeze([
  {
    name: HOSTED_TOOL_DISCOVERY_NAME,
    description:
      'Find available application actions by name or description and return their original names, exact input schemas and effects. Use an empty query to list all actions, following nextOffset until null. Native file/process tools are already offered directly. Discovery changes no workspace data.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Action name or search words; empty to enumerate all actions.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Use nextOffset from the previous page; initially zero.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 8,
          description: 'Maximum contracts to return; defaults to four.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: HOSTED_TOOL_DISPATCH_NAME,
    description:
      'Request one discovered application action using its unchanged canonical name and JSON arguments matching its exact input schema. The original action determines permissions, required previews and approval. Use existing preview/apply actions separately and retain their tokens. Native file/process tools remain directly available.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact original action name returned by discovery.' },
        arguments: {
          type: 'string',
          description: 'JSON object matching the original action input schema.',
        },
      },
      required: ['name', 'arguments'],
      additionalProperties: false,
    },
  },
]);

export function decodeHostedToolDispatch(value: unknown): {
  readonly name: string;
  readonly input: Record<string, unknown>;
} {
  const envelope = HostedToolDispatchInputSchema.parse(value);
  if (new TextEncoder().encode(envelope.arguments).byteLength > MAX_HOSTED_WHOLE_REQUEST_BYTES) {
    throw new Error('Hosted action arguments exceed the request limit');
  }
  const input: unknown = JSON.parse(envelope.arguments);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Hosted action arguments must be a JSON object');
  }
  return { name: envelope.name, input: input as Record<string, unknown> };
}
