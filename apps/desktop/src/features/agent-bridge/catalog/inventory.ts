import {
  createInventoryTool,
  inventoryAgentSchema,
  inventoryAgentJsonSchema,
  inventoryAgentOutputSchema,
  INVENTORY_DESCRIPTION,
} from '../../ai/tools/inventory';
import { defineRendererToolCatalog, resultSdkRendererTool } from './types';

export const inventoryTools = defineRendererToolCatalog({
  inventory: {
    name: 'inventory',
    sidecarOrchestrated: true,
    description: INVENTORY_DESCRIPTION,
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: ['write-workspace'],
    audit_required: true,
    effects: ['read-only', 'mutating'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    inputSchema: inventoryAgentSchema,
    inputSchemaJson: inventoryAgentJsonSchema,
    outputSchema: inventoryAgentOutputSchema,
    resolveInputAuthorization: (args) => ({
      additionalRequiredCapabilities: [
        'execute',
        'apply-arrival',
        'apply-scientific-transfer',
        'apply-scientific-transfer-v2',
      ].includes((args as { operation?: { kind?: string } }).operation?.kind ?? '')
        ? ['write-workspace']
        : [],
    }),
    execution: resultSdkRendererTool(() => createInventoryTool()),
  },
});
