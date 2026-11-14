import {
  mergeRendererToolCatalogs,
  type RendererToolDefinition,
  type RendererCapability,
} from './catalog/types';
export type {
  RendererCapability,
  RendererToolEffect,
  RendererToolExecutionContext,
  RendererToolShape,
  RendererWorkspaceGrounding,
  RendererToolExposure,
  RendererToolHistoryPresentation,
  RendererMcpAnnotations,
  RendererTransportInputRequirement,
  RendererToolInputAuthorization,
  RendererToolDefinition,
} from './catalog/types';
export { executeRendererToolDefinition, rendererToolSdkInputSchema } from './catalog/types';
export {
  assemblyListEditableFieldsSchema,
  assemblySetEditableFieldSchema,
} from './catalog/helpers';
import { workspaceTools } from './catalog/workspace';
import { operationsTools } from './catalog/operations';
import { papersTools } from './catalog/papers';
import { designsTools } from './catalog/designs';
import { genomesTools } from './catalog/genomes';
import { sequencesTools } from './catalog/sequences';
import { structuresTools } from './catalog/structures';
import { registryTools } from './catalog/registry';
import { inventoryTools } from './catalog/inventory';
import { computeTools } from './catalog/compute';
import { scientificAuthoringTools } from './catalog/scientific-authoring';

import { defineRendererToolCatalog, resultSdkRendererTool } from './catalog/types';
import {
  createImportReviewTool,
  importReviewSchema,
  importReviewOutputSchema,
  IMPORT_REVIEW_DESCRIPTION,
} from '../ai/public/tools/import-review';
import {
  createAdministrationTool,
  administrationSchema,
  administrationOutputSchema,
  ADMINISTRATION_DESCRIPTION,
} from '../ai/public/tools/administration';
import {
  createSearchWorkspaceTool,
  searchWorkspaceSchema,
  searchWorkspaceOutputSchema,
  SEARCH_WORKSPACE_DESCRIPTION,
} from '../ai/public/tools/search-workspace';
import {
  createProjectHistoryTool,
  projectHistorySchema,
  projectHistoryOutputSchema,
  PROJECT_HISTORY_DESCRIPTION,
} from '../ai/public/tools/project-history';
import {
  createFileDocumentTool,
  fileDocumentSchema,
  fileDocumentOutputSchema,
  FILE_DOCUMENT_DESCRIPTION,
} from '../ai/public/tools/file-document';
import {
  createSequenceDocumentTool,
  sequenceDocumentSchema,
  sequenceDocumentOutputSchema,
} from '../ai/public/tools/sequence-document';
import {
  createNotebookDocumentTool,
  notebookDocumentSchema,
  notebookDocumentOutputSchema,
  notebookInputSchemaOptions,
} from '../ai/public/tools/notebook-document';

const nativeDocumentTools = defineRendererToolCatalog({
  import_review: {
    name: 'import_review',
    sidecarOrchestrated: true,
    description: IMPORT_REVIEW_DESCRIPTION,
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: ['write-workspace', 'external-compute:tm'],
    audit_required: true,
    effects: ['read-only', 'mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    outputSchema: importReviewOutputSchema,
    inputSchema: importReviewSchema,
    resolveInputAuthorization: (args) => {
      const operation = (args as { operation?: { kind?: string; command?: { kind?: string } } })
        .operation;
      return {
        additionalRequiredCapabilities:
          operation?.kind === 'execute' && operation.command?.kind === 'inspect'
            ? []
            : ['write-workspace'],
      };
    },
    execution: resultSdkRendererTool((context) => createImportReviewTool(context.folders)),
  },
  administration: {
    name: 'administration',
    sidecarOrchestrated: true,
    description: ADMINISTRATION_DESCRIPTION,
    shape: 'app-action',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: [
      'modify-settings',
      'write-workspace',
      'manage-agent-access',
    ],
    audit_required: true,
    effects: ['read-only', 'mutating', 'external-submit'],
    requiresWorkspace: false,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'none',
    exposure: { kind: 'shared' },
    outputSchema: administrationOutputSchema,
    inputSchema: administrationSchema,
    resolveInputAuthorization: (args) => {
      const operation = (args as { operation?: { kind?: string; target?: { purpose?: string } } })
        .operation;
      return {
        additionalRequiredCapabilities:
          operation?.kind === 'update-settings' || operation?.kind === 'retry-settings'
            ? ['modify-settings']
            : operation?.kind === 'prepare-share' ||
                operation?.kind === 'prepare-share-import' ||
                operation?.kind === 'prepare-migration'
              ? ['write-workspace']
              : operation?.kind === 'prepare-handoff' &&
                  operation.target?.purpose === 'agent-access'
                ? ['manage-agent-access']
                : [],
      };
    },
    execution: resultSdkRendererTool(() => createAdministrationTool()),
  },
  search_workspace: {
    name: 'search_workspace',
    sidecarOrchestrated: true,
    description: SEARCH_WORKSPACE_DESCRIPTION,
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: [],
    audit_required: true,
    effects: ['read-only'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    outputSchema: searchWorkspaceOutputSchema,
    inputSchema: searchWorkspaceSchema,
    execution: resultSdkRendererTool((context) => createSearchWorkspaceTool(context.folders)),
  },
  project_history: {
    name: 'project_history',
    sidecarOrchestrated: true,
    description: PROJECT_HISTORY_DESCRIPTION,
    shape: 'app-action',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: ['write-workspace'],
    audit_required: true,
    effects: ['read-only', 'mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    outputSchema: projectHistoryOutputSchema,
    inputSchema: projectHistorySchema,
    resolveInputAuthorization: (args) => ({
      additionalRequiredCapabilities:
        (args as { operation?: { kind?: string } }).operation?.kind === 'inspect'
          ? []
          : ['write-workspace'],
    }),
    execution: resultSdkRendererTool((context) => createProjectHistoryTool(context.folders)),
  },
  file_document: {
    name: 'file_document',
    sidecarOrchestrated: true,
    description: FILE_DOCUMENT_DESCRIPTION,
    shape: 'data-service',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: ['write-workspace', 'read-sequences'],
    audit_required: true,
    effects: ['read-only', 'mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    outputSchema: fileDocumentOutputSchema,
    inputSchema: fileDocumentSchema,
    resolveInputAuthorization: (args) => {
      const operation = (
        args as {
          operation?: { kind?: string; command?: { kind?: string; command?: { kind?: string } } };
        }
      ).operation;
      return {
        additionalRequiredCapabilities: [
          ...(operation?.kind === 'sequence' ? (['read-sequences'] as const) : []),
          ...(operation?.kind === 'inspect' ||
          operation?.kind === 'list-dirty' ||
          ((operation?.kind === 'table' ||
            operation?.kind === 'sequence' ||
            operation?.kind === 'notebook') &&
            operation.command?.kind === 'inspect') ||
          (operation?.kind === 'notebook' &&
            (operation.command?.kind === 'schema' ||
              (operation.command?.kind === 'table' &&
                operation.command.command?.kind === 'inspect')))
            ? []
            : (['write-workspace'] as const)),
        ],
      };
    },
    execution: resultSdkRendererTool((context) => createFileDocumentTool(context.folders)),
  },
  notebook_document: {
    name: 'notebook_document',
    sidecarOrchestrated: true,
    description:
      'Inspect, search, create and edit native notebook working copies without opening an editor. Human views attach to the same draft, history and save owner. One insert path handles entity references, image/structure files and tables. schema discovers native nodes and embeds; splice-blocks edits formatted content and properties. Inspect first for the current revision. Save publishes the existing native package format.',
    shape: 'app-action',
    required_capabilities: ['read-workspace'],
    conditional_required_capabilities: ['write-workspace', 'create-entity'],
    audit_required: true,
    effects: ['read-only', 'mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    outputSchema: notebookDocumentOutputSchema,
    inputSchema: notebookDocumentSchema,
    inputSchemaOptions: notebookInputSchemaOptions,
    resolveInputAuthorization: (args) => {
      const operation = (args as { operation?: { kind?: string; command?: { kind?: string } } })
        .operation;
      const kind = operation?.kind;
      return {
        additionalRequiredCapabilities:
          kind === 'inspect' ||
          kind === 'schema' ||
          kind === 'search' ||
          kind === 'list' ||
          (kind === 'table' && operation?.command?.kind === 'inspect')
            ? []
            : kind === 'create'
              ? ['write-workspace', 'create-entity']
              : ['write-workspace'],
      };
    },
    execution: resultSdkRendererTool((context) => createNotebookDocumentTool(context.folders)),
  },
  sequence_document: {
    name: 'sequence_document',
    sidecarOrchestrated: true,
    description:
      'Inspect, edit bases and annotations, undo, redo, discard or save an existing sequence through its native working-copy owner without opening a tab. Human views attach to the same draft and history. Inspect first for its version. Base ranges are zero-based half-open; annotation bounds are one-based inclusive. Edits remain drafts until save. Scientific parsing and package persistence retain their existing owners.',
    shape: 'data-service',
    required_capabilities: ['read-workspace', 'read-sequences'],
    conditional_required_capabilities: ['write-workspace'],
    audit_required: true,
    effects: ['read-only', 'mutating'],
    requiresWorkspace: true,
    conditionallyRequiresWorkspace: false,
    workspaceGrounding: 'always',
    exposure: { kind: 'shared' },
    outputSchema: sequenceDocumentOutputSchema,
    inputSchema: sequenceDocumentSchema,
    resolveInputAuthorization: (args) => ({
      additionalRequiredCapabilities:
        (args as { operation?: { kind?: string } }).operation?.kind === 'inspect'
          ? []
          : ['write-workspace'],
    }),
    execution: resultSdkRendererTool((context) => createSequenceDocumentTool(context.folders)),
  },
});

export const ALLOWED_RENDERER_TOOLS = mergeRendererToolCatalogs(
  {
    ...workspaceTools,
    file_document: nativeDocumentTools.file_document,
    notebook_document: nativeDocumentTools.notebook_document,
  },
  operationsTools,
  papersTools,
  designsTools,
  genomesTools,
  { ...sequencesTools, sequence_document: nativeDocumentTools.sequence_document },
  structuresTools,
  registryTools,
  inventoryTools,
  computeTools,
  {
    import_review: nativeDocumentTools.import_review,
    administration: nativeDocumentTools.administration,
    search_workspace: nativeDocumentTools.search_workspace,
    project_history: nativeDocumentTools.project_history,
  },
  scientificAuthoringTools
);

export type RendererToolName = keyof typeof ALLOWED_RENDERER_TOOLS;

const rendererToolNameByHostedName = new Map<string, RendererToolName>();

for (const rendererToolName of Object.keys(ALLOWED_RENDERER_TOOLS) as RendererToolName[]) {
  const definition: RendererToolDefinition = ALLOWED_RENDERER_TOOLS[rendererToolName];
  const hostedName = definition.providerAlias ?? rendererToolName;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(hostedName)) {
    throw new Error(`Renderer tool has a provider-incompatible Hosted name: ${hostedName}`);
  }
  if (rendererToolNameByHostedName.has(hostedName)) {
    throw new Error(`Duplicate Hosted provider tool name: ${hostedName}`);
  }
  rendererToolNameByHostedName.set(hostedName, rendererToolName);
}

export function hostedToolNameForRenderer(rendererToolName: RendererToolName): string {
  const definition: RendererToolDefinition = ALLOWED_RENDERER_TOOLS[rendererToolName];
  return definition.providerAlias ?? rendererToolName;
}

export function rendererToolNameForHosted(hostedName: string): RendererToolName | null {
  return rendererToolNameByHostedName.get(hostedName) ?? null;
}

export function getAllowedRendererTool(toolName: string): RendererToolDefinition | null {
  return Object.prototype.hasOwnProperty.call(ALLOWED_RENDERER_TOOLS, toolName)
    ? ALLOWED_RENDERER_TOOLS[toolName as keyof typeof ALLOWED_RENDERER_TOOLS]
    : null;
}

export interface ResolvedRendererToolAuthorization {
  requiredCapabilities: readonly RendererCapability[];
  requiresWorkspace: boolean;
}

export function resolveRendererToolAuthorization(
  toolName: string,
  input: unknown
): ResolvedRendererToolAuthorization | null {
  const tool = getAllowedRendererTool(toolName);
  if (!tool) return null;
  const conditional = tool.resolveInputAuthorization?.(input);
  if (
    conditional?.requiresWorkspace === true &&
    !tool.requiresWorkspace &&
    !tool.conditionallyRequiresWorkspace
  )
    throw new Error(`Renderer tool ${toolName} has an undeclared workspace requirement.`);
  const requiredCapabilities = [...tool.required_capabilities];
  for (const capability of conditional?.additionalRequiredCapabilities ?? []) {
    if (
      !tool.required_capabilities.includes(capability) &&
      !tool.conditional_required_capabilities.includes(capability)
    )
      throw new Error(`Renderer tool ${toolName} requires undeclared capability ${capability}.`);
    if (!requiredCapabilities.includes(capability)) requiredCapabilities.push(capability);
  }
  return {
    requiredCapabilities,
    requiresWorkspace: tool.requiresWorkspace || conditional?.requiresWorkspace === true,
  };
}
