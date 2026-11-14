import { z } from 'zod';
import { jsonSchema, zodSchema } from 'ai';
import { assertToolOperationResult } from '../tool-result';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  molecularTrialToolScope,
  filterMolecularTrialStructures,
  molecularTrialProteinContextBinding,
  validateMolecularTrialProteinAuthorChain,
} from '../molecular-trial-scope';
import { getRegisteredStructureSelectionContext } from '../structure-tools';

export type RendererCapability =
  | 'read-workspace'
  | 'modify-tabs'
  | 'create-entity'
  | 'read-sequences'
  | 'edit-assembly'
  | 'edit-primers'
  | 'edit-protocols'
  | 'finalize-protocol'
  | 'write-workspace'
  | 'operations.read'
  | 'operations.start'
  | 'finalize-assembly'
  | 'modify-settings'
  | 'manage-agent-access'
  | 'submit-feedback'
  | 'external-fetch:annotation'
  | 'external-fetch:xref-resolution'
  | 'external-fetch:structure'
  | 'external-fetch:paper'
  | 'external-compute:tm'
  | 'external-compute:discover'
  | 'external-compute:submit'
  | 'external-compute:manage';

export type RendererToolEffect = 'read-only' | 'mutating' | 'ui-bound' | 'external-submit';

export interface RendererToolExecutionContext {
  projectScope?: import('../../../shared/agent-project-scope').AgentProjectScope;
  turnId?: string;
  folders: WorkspaceFolder[];
  actionId: string;
  grantedCapabilities: readonly string[];
  abortSignal?: AbortSignal;

  trustedContext?: unknown;
}

export type RendererToolShape = 'app-action' | 'data-service' | 'viz-tab-action';

export type RendererWorkspaceGrounding =
  | 'always'
  | 'none'
  | 'when-workspace-file'
  | 'when-existing-reference'
  | 'when-ref-id';

export type RendererToolExposure =
  | { readonly kind: 'shared' }
  | { readonly kind: 'mcp-only'; readonly reason: string };

export interface RendererToolHistoryPresentation {
  readonly mode: 'reactivate';
  readonly handler: 'open-tab' | 'highlight-range';
  readonly label: string;
}

export interface RendererMcpAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export type RendererTransportInputRequirement =
  | {
      readonly kind: 'exactly-one';
      readonly fields: readonly [string, string, ...string[]];
    }
  | {
      readonly kind: 'at-least-one';
      readonly fields: readonly [string, ...string[]];
    };

export interface RendererToolInputAuthorization {
  readonly additionalRequiredCapabilities?: readonly RendererCapability[];
  readonly requiresWorkspace?: boolean;
}

export interface RendererToolMetadata {
  readonly name: string;
  readonly description: string;
  readonly shape: RendererToolShape;
  readonly required_capabilities: readonly RendererCapability[];
  readonly conditional_required_capabilities: readonly RendererCapability[];
  readonly audit_required: true;
  readonly inputSchema: z.ZodTypeAny;
  readonly inputSchemaJson?: () => Record<string, unknown>;
  readonly inputSchemaOptions?: { readonly useReferences: boolean };

  readonly outputSchema: z.ZodTypeAny;
  readonly effects: readonly RendererToolEffect[];
  readonly requiresWorkspace: boolean;
  readonly conditionallyRequiresWorkspace: boolean;
  readonly workspaceGrounding?: RendererWorkspaceGrounding;
  readonly mcpAnnotations?: RendererMcpAnnotations;
  readonly providerAlias?: string;
  readonly emptyInputReason?: string;
  readonly historyPresentation?: RendererToolHistoryPresentation;
  readonly transportInputRequirement?: RendererTransportInputRequirement;
  readonly exposure: RendererToolExposure;
  readonly resolveInputAuthorization?: (args: unknown) => RendererToolInputAuthorization;

  readonly sidecarOrchestrated?: boolean;

  readonly projectAuditResult?: (result: unknown) => unknown;
}

export interface RendererSdkTool {
  readonly resultContract: 'explicit-v1';
  readonly execute?: (...args: never[]) => unknown;
}

export interface RendererSdkExecution {
  readonly kind: 'sdk';
  readonly createTool: (context: RendererToolExecutionContext) => RendererSdkTool;
  readonly resultContract: 'explicit-v1';
}

export interface RendererCustomExecution {
  readonly kind: 'custom';
  readonly handler: (args: unknown, context: RendererToolExecutionContext) => Promise<unknown>;
  readonly resultContract: 'explicit-v1';
}

export type RendererToolDefinition = RendererToolMetadata & {
  readonly execution: RendererSdkExecution | RendererCustomExecution;
};

export function rendererToolSdkInputSchema(definition: RendererToolDefinition) {
  if (definition.inputSchemaJson)
    return jsonSchema(definition.inputSchemaJson(), {
      validate: async (input) => {
        const parsed = definition.inputSchema.safeParse(input);
        return parsed.success
          ? { success: true, value: parsed.data }
          : { success: false, error: parsed.error };
      },
    });
  return definition.inputSchemaOptions
    ? zodSchema(definition.inputSchema, definition.inputSchemaOptions)
    : definition.inputSchema;
}

export function resultSdkRendererTool(
  createTool: RendererSdkExecution['createTool']
): RendererSdkExecution {
  return { kind: 'sdk', createTool, resultContract: 'explicit-v1' };
}

export function customRendererTool(
  handler: RendererCustomExecution['handler']
): RendererCustomExecution {
  return { kind: 'custom', handler, resultContract: 'explicit-v1' };
}

export function defineRendererToolCatalog<
  const Catalog extends Record<string, RendererToolDefinition>,
>(
  catalog: Catalog & {
    readonly [Name in keyof Catalog]: Catalog[Name] & { readonly name: Name };
  }
): Catalog {
  return catalog;
}

export async function executeRendererToolDefinition(
  definition: RendererToolDefinition,
  args: unknown,
  context: RendererToolExecutionContext
): Promise<unknown> {
  const owned = molecularTrialToolScope(definition.name, args, context.turnId);
  if (definition.name === 'protein_get_context' && owned) {
    const binding = molecularTrialProteinContextBinding(args, context.turnId)!;
    const source = await getRegisteredStructureSelectionContext(binding.structureViewId);
    validateMolecularTrialProteinAuthorChain(binding, source.chains);
  }
  let result: unknown;
  if (definition.execution.kind === 'custom') {
    result = await definition.execution.handler(args, context);
  } else {
    const sdkTool = definition.execution.createTool(context);
    if (!sdkTool.execute) throw new Error('Renderer tool has no execute handler');
    result = await Reflect.apply(sdkTool.execute, sdkTool, [
      args,
      {
        toolCallId: context.actionId,
        messages: [],
        abortSignal: context.abortSignal,
        grantedCapabilities: [...context.grantedCapabilities],
      },
    ]);
  }
  if (definition.name === 'mol_list_structures')
    result = filterMolecularTrialStructures(result, owned);
  assertToolOperationResult(result);
  return result;
}

type CatalogIntersection<Union> = (
  Union extends unknown ? (catalog: Union) => void : never
) extends (catalog: infer Intersection) => void
  ? Intersection
  : never;

export function mergeRendererToolCatalogs<
  const Catalogs extends readonly Record<string, RendererToolDefinition>[],
>(...catalogs: Catalogs): CatalogIntersection<Catalogs[number]> {
  const merged: Record<string, RendererToolDefinition> = Object.create(null);
  for (const catalog of catalogs)
    for (const [name, definition] of Object.entries(catalog)) {
      if (Object.prototype.hasOwnProperty.call(merged, name))
        throw new Error('Duplicate renderer tool: ' + name);
      merged[name] = definition;
    }
  return merged as CatalogIntersection<Catalogs[number]>;
}
