import {
  createProtocolDocumentTool,
  PROTOCOL_DOCUMENT_DESCRIPTION,
  protocolDocumentOutputSchema,
} from '../../ai/tools/protocol-document';
import {
  protocolDocumentAgentRequestSchema,
  protocolOperationCapabilities,
} from '../../../shared/protocol-command';
import { defineRendererToolCatalog, resultSdkRendererTool } from './types';

export const protocolTools = defineRendererToolCatalog({
  protocol_document: {
    name: 'protocol_document',
    sidecarOrchestrated: true,
    description: PROTOCOL_DOCUMENT_DESCRIPTION,
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: ['write-workspace', 'create-entity'],
    audit_required: true,
    effects: ['read-only', 'mutating'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    inputSchema: protocolDocumentAgentRequestSchema,
    outputSchema: protocolDocumentOutputSchema,
    resolveInputAuthorization: (args) => {
      const kind = (args as { operation?: { kind?: string } }).operation?.kind;
      return {
        additionalRequiredCapabilities: protocolOperationCapabilities(kind ?? '').filter(
          (capability) => capability !== 'read-workspace'
        ),
      };
    },
    execution: resultSdkRendererTool(() => createProtocolDocumentTool()),
  },
});
