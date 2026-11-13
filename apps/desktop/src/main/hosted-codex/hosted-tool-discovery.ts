import { createHash } from 'node:crypto';
import {
  decodeHostedToolDispatch,
  HOSTED_NATIVE_TOOL_DEFINITIONS,
  HOSTED_TOOL_TRANSPORT_DEFINITIONS,
  HostedToolDiscoveryInputSchema,
} from '@waypoint/hosted-ai-contract';
import type { HostedCodexTool, HostedCodexToolCatalog } from './dynamic-tool-catalog';
import { rankDiscoveryCandidates } from '../discovery-ranking';
import type { DiscoveryRanker } from '../../shared/discovery-ranking';
import { createToolDescriptorSearch } from '../../shared/tool-discovery-search';

const nativeNames = new Set<string>(HOSTED_NATIVE_TOOL_DEFINITIONS.map((tool) => tool.name));
const lexicalIndexes = new WeakMap<
  HostedCodexToolCatalog,
  ReturnType<typeof createToolDescriptorSearch<HostedCodexTool>>
>();
function descriptorSearch(catalog: HostedCodexToolCatalog) {
  let index = lexicalIndexes.get(catalog);
  if (!index) {
    index = createToolDescriptorSearch(catalog.tools.filter((tool) => !nativeNames.has(tool.name)));
    lexicalIndexes.set(catalog, index);
  }
  return index;
}

export function createHostedToolDiscovery(
  catalog: HostedCodexToolCatalog,
  rank: DiscoveryRanker = rankDiscoveryCandidates
) {
  const rankings = new Map<string, Promise<readonly HostedCodexTool[]>>();
  return async (input: unknown, signal?: AbortSignal) => {
    const { query, offset = 0, limit = 4 } = HostedToolDiscoveryInputSchema.parse(input);
    signal?.throwIfAborted();
    if (!query.trim()) return discoverHostedTools(catalog, input);
    if (descriptorSearch(catalog).exact(query)) return discoverHostedTools(catalog, input);
    let ranking = rankings.get(query);
    if (!ranking) {
      if (rankings.size >= 16) return discoverHostedTools(catalog, input);
      ranking = (async () => {
        const eligible = catalog.tools.filter((tool) => !nativeNames.has(tool.name));
        const ids = await rank(
          query,
          eligible.map((tool) => ({
            id: tool.name,
            name: tool.name,
            description: tool.description,
          })),
          signal
        );
        if (ids === null) {
          return lexicalToolMatches(catalog, query);
        }
        const byId = new Map(eligible.map((tool) => [tool.name, tool]));
        return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
      })();
      rankings.set(query, ranking);
    }
    const matches = await ranking;
    signal?.throwIfAborted();
    const tools = matches.slice(offset, offset + limit);
    return {
      tools,
      total: matches.length,
      nextOffset: offset + tools.length < matches.length ? offset + tools.length : null,
    };
  };
}

function lexicalToolMatches(catalog: HostedCodexToolCatalog, query: string): HostedCodexTool[] {
  return descriptorSearch(catalog).search(query);
}

export function buildHostedProviderToolCatalog(
  canonical: HostedCodexToolCatalog
): HostedCodexToolCatalog {
  for (const definition of HOSTED_TOOL_TRANSPORT_DEFINITIONS) {
    if (canonical.tools.some((tool) => tool.name === definition.name)) {
      throw new Error('A canonical action collides with a Hosted transport name');
    }
  }
  const tools: HostedCodexTool[] = [
    ...HOSTED_TOOL_TRANSPORT_DEFINITIONS.map((definition) => ({
      ...definition,

      effects: [],
      requiresWorkspace: false,
    })),
    ...canonical.tools.filter((tool) => nativeNames.has(tool.name)),
  ];
  return {
    tools,
    digest: createHash('sha256')
      .update(JSON.stringify({ canonical: canonical.digest, tools }))
      .digest('hex'),
  };
}

export function discoverHostedTools(
  catalog: HostedCodexToolCatalog,
  input: unknown
): {
  readonly tools: readonly HostedCodexTool[];
  readonly total: number;
  readonly nextOffset: number | null;
} {
  const { query, offset = 0, limit = 4 } = HostedToolDiscoveryInputSchema.parse(input);
  const matches = lexicalToolMatches(catalog, query);
  const tools = matches.slice(offset, offset + limit);
  return {
    tools,
    total: matches.length,
    nextOffset: offset + tools.length < matches.length ? offset + tools.length : null,
  };
}

export function resolveHostedToolDispatch(
  catalog: HostedCodexToolCatalog,
  envelope: unknown
): {
  readonly tool: HostedCodexTool;
  readonly input: Record<string, unknown>;
} {
  const { name, input } = decodeHostedToolDispatch(envelope);
  const tool = catalog.tools.find((candidate) => candidate.name === name && !nativeNames.has(name));
  if (!tool) throw new Error('The requested action is unavailable in this Hosted turn');
  return { tool, input };
}
