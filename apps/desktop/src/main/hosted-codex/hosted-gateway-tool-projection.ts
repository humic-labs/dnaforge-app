import {
  HOSTED_TOOL_DISPATCH_NAME,
  HOSTED_RESPONSES_MAX_TOOLS,
  MAX_HOSTED_WHOLE_REQUEST_BYTES,
  hostedResponsesFunctionWireName,
} from '@waypoint/hosted-ai-contract';
import {
  hostedCodexWireInputSchema,
  type HostedCodexTool,
  type HostedCodexToolCatalog,
} from './dynamic-tool-catalog';
import { resolveHostedToolDispatch } from './hosted-tool-discovery';
import type { AcceptedResponsesRequest } from './responses-wire';
import type { HostedToolInventoryCounts } from './tool-inventory-observation';

type ProjectionCounts = Omit<
  HostedToolInventoryCounts,
  'authorizationCatalogDefinitionCount' | 'registeredChildDefinitionCount'
>;

const dispatchWireName = hostedResponsesFunctionWireName(HOSTED_TOOL_DISPATCH_NAME);
const MAX_RETAINED_ACTIONS = 32;
const WORKFLOW_ENVELOPE_RESERVE_BYTES = 4_096;
const DISCOVERY_GUIDANCE =
  'Discover only the next needed application action. Do not enumerate the catalog. ' +
  'When you know an action name, query that exact name. Natural-language searches rank action names, descriptions and operation schemas; ' +
  'use separate queries for separate action names. Invoke returned canonical functions directly. ' +
  'Recent discovered functions remain offered across pages; rediscover an action if it is no longer offered.';

export function hostedToolFunctionDefinition(tool: HostedCodexTool) {
  return {
    type: 'function',
    name: hostedResponsesFunctionWireName(tool.name),
    description: tool.description,
    strict: false,
    parameters: hostedCodexWireInputSchema(tool.inputSchema),
  };
}

export function createHostedGatewayToolProjection(catalog: HostedCodexToolCatalog) {
  const recent = new Map<string, HostedCodexTool>();
  let acceptedDiscoveryPageCount = 0;
  let lastAcceptedDiscoveryPageDefinitionCount = 0;
  let maxAcceptedDiscoveryPageDefinitionCount = 0;
  let maxRetainedDefinitionCount = 0;
  let projectionSequence = 0;
  const inventoryState = () => ({
    retainedDefinitionCount: recent.size,
    maxRetainedDefinitionCount,
    acceptedDiscoveryPageCount,
    lastAcceptedDiscoveryPageDefinitionCount,
    maxAcceptedDiscoveryPageDefinitionCount,
  });
  return {
    inventorySummary: () => ({ ...inventoryState(), projectionCount: projectionSequence }),
    remember(page: readonly HostedCodexTool[]): void {
      if (page.length > 8 || new Set(page.map((tool) => tool.name)).size !== page.length) {
        throw new Error('The Hosted discovery page exceeds its bounded inventory');
      }
      const trusted = page.map(
        (candidate) =>
          resolveHostedToolDispatch(catalog, { name: candidate.name, arguments: '{}' }).tool
      );
      for (const tool of trusted) {
        recent.delete(tool.name);
        recent.set(tool.name, tool);
      }
      while (recent.size > MAX_RETAINED_ACTIONS) recent.delete(recent.keys().next().value!);
      acceptedDiscoveryPageCount += 1;
      lastAcceptedDiscoveryPageDefinitionCount = trusted.length;
      maxAcceptedDiscoveryPageDefinitionCount = Math.max(
        maxAcceptedDiscoveryPageDefinitionCount,
        trusted.length
      );
      maxRetainedDefinitionCount = Math.max(maxRetainedDefinitionCount, recent.size);
    },
    project(
      accepted: AcceptedResponsesRequest,
      observe?: (counts: ProjectionCounts) => void
    ): AcceptedResponsesRequest {
      const baseCount = (accepted.forwarded.tools as readonly { name?: unknown }[]).filter(
        (tool) => tool.name !== dispatchWireName
      ).length;
      const capacity = Math.min(MAX_RETAINED_ACTIONS, HOSTED_RESPONSES_MAX_TOOLS - baseCount);
      if (capacity < 0) throw new Error('The Hosted provider inventory exceeds its tool limit');
      while (recent.size > capacity) recent.delete(recent.keys().next().value!);
      for (;;) {
        const projected = projectHostedGatewayTools(accepted, catalog, [...recent.values()]);
        if (
          Buffer.byteLength(JSON.stringify(projected.forwarded), 'utf8') <=
          MAX_HOSTED_WHOLE_REQUEST_BYTES - WORKFLOW_ENVELOPE_RESERVE_BYTES
        ) {
          const currentProjectionSequence = projectionSequence++;
          try {
            observe?.({
              projectionSequence: currentProjectionSequence,
              childOfferedDefinitionCount: (accepted.forwarded.tools as readonly unknown[]).length,
              gatewayBaseDefinitionCount: baseCount,
              gatewayForwardedDefinitionCount: (projected.forwarded.tools as readonly unknown[])
                .length,
              ...inventoryState(),
            });
          } catch {
            return projected;
          }
          return projected;
        }
        if (recent.size === 0)
          throw new Error('The Hosted projected request exceeds its size limit');
        recent.delete(recent.keys().next().value!);
      }
    },
  };
}

export function projectHostedGatewayTools(
  accepted: AcceptedResponsesRequest,
  catalog: HostedCodexToolCatalog,
  discovered: readonly HostedCodexTool[]
): AcceptedResponsesRequest {
  if (
    discovered.length > MAX_RETAINED_ACTIONS ||
    new Set(discovered.map((tool) => tool.name)).size !== discovered.length
  ) {
    throw new Error('The Hosted discovered inventory exceeds its bounded inventory');
  }
  const choice = accepted.forwarded.tool_choice;
  if (
    choice &&
    typeof choice === 'object' &&
    'name' in choice &&
    choice.name === dispatchWireName
  ) {
    throw new Error('A forced SDK dispatcher cannot be forwarded as a canonical gateway action');
  }
  const tools = (accepted.forwarded.tools as readonly Readonly<Record<string, unknown>>[]).filter(
    (tool) => tool.name !== dispatchWireName
  );
  for (const discoveredTool of discovered) {
    const { tool } = resolveHostedToolDispatch(catalog, {
      name: discoveredTool.name,
      arguments: '{}',
    });
    tools.push(hostedToolFunctionDefinition(tool));
  }
  const input = Array.isArray(accepted.forwarded.input)
    ? accepted.forwarded.input.map((item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        const call = item as Record<string, unknown>;
        if (call.type !== 'function_call' || call.name !== dispatchWireName) return item;
        if (typeof call.arguments !== 'string') throw new Error('Invalid Hosted dispatch history');
        const { tool, input } = resolveHostedToolDispatch(catalog, JSON.parse(call.arguments));
        return {
          ...call,
          name: hostedResponsesFunctionWireName(tool.name),
          arguments: JSON.stringify(input),
        };
      })
    : accepted.forwarded.input;
  return {
    ...accepted,
    forwarded: {
      ...accepted.forwarded,
      input,
      tools,
      instructions: [accepted.forwarded.instructions, DISCOVERY_GUIDANCE]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join('\n\n'),
    },
  };
}
