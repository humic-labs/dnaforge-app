import { toolSuccess } from '../tool-result';
import { designToolFailure, runDesignTool } from '../../ai/public/tools/design-tool-result';
import { z } from 'zod';
import { useDesignStore } from '../../design/public/store';
import { useStructure3dStore } from '../../page/public/embeds/structure3d/store';
import type {
  Structure3dAttrs,
  Structure3dSource,
} from '../../page/public/embeds/structure3d/types';
import { getStructureKey } from '../../page/public/embeds/structure3d/molstar/cache';
import { getMolstarPropsFromAttrs } from '../../page/public/embeds/structure3d/utils/molstarPropsUtils';
import { resolvePrimerTmModelForCall } from '../../ai/public/tools/configure-primer-tm';
import {
  genomeSourceLocators,
  isRemoteGenomeSourceLocator,
} from '../../ai/public/tools/import-genome-sources';
import { externalFetchTool, externalFetchSchema } from '../../ai/public/tools/external-fetch';
import {
  applyAssemblyEditableFieldValue,
  listAssemblyEditableFields,
} from '../../junction-workbench/public/assembly-field-adapter';
import { isRegisteredStructureAgentVisible } from '../structure-tools/visibility';
import { handleSeqListAnnotations } from '../sequence-tools';
import { RendererCapability, RendererToolExecutionContext, RendererMcpAnnotations } from './types';

export const READ_ONLY_IDEMPOTENT_MCP_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
} satisfies RendererMcpAnnotations;

export const UI_IDEMPOTENT_MCP_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
} satisfies RendererMcpAnnotations;

export function projectSequenceHistoryReadAudit(result: unknown): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const value = result as Record<string, unknown>;
  return {
    ok: value.ok,
    code: value.code,
    documentId: value.documentId,
    revisionId: value.revisionId,
    itemId: value.itemId,
    present: value.present,
    referenceSha256: value.referenceSha256,
  };
}

export function isExternalServiceCapability(capability: string): boolean {
  return (
    capability === '*' ||
    capability.startsWith('external-fetch:') ||
    capability.startsWith('external-compute:')
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveCreateReferenceAuthorization(args: unknown): {
  additionalRequiredCapabilities?: readonly RendererCapability[];
  requiresWorkspace?: boolean;
} {
  if (isRecord(args) && args.entityType === 'primer')
    return { additionalRequiredCapabilities: ['read-workspace', 'read-sequences'] };
  if (!isRecord(args) || !isRecord(args.selection)) return {};
  if (args.selection.kind !== 'saved_residue_selection') {
    return {
      additionalRequiredCapabilities: ['read-workspace'],
    };
  }
  return {
    additionalRequiredCapabilities: ['read-workspace'],
    requiresWorkspace: true,
  };
}

export function resolveImportSequenceAuthorization(args: unknown): {
  additionalRequiredCapabilities?: readonly RendererCapability[];
} {
  if (
    !isRecord(args) ||
    !isRecord(args.source) ||
    !['ncbi', 'url'].includes(String(args.source.kind))
  )
    return {};
  return { additionalRequiredCapabilities: ['external-fetch:annotation'] };
}

export function resolveImportGenomeSourcesAuthorization(args: unknown): {
  additionalRequiredCapabilities?: readonly RendererCapability[];
  requiresWorkspace?: boolean;
} {
  if (!isRecord(args) || !Array.isArray(args.sources)) return {};
  const locators = args.sources.flatMap((spec) =>
    isRecord(spec) && isRecord(spec.source)
      ? genomeSourceLocators({
          source: spec.source as { kind: string },
          index: isRecord(spec.index) ? (spec.index as { kind: string }) : undefined,
          reference: isRecord(spec.reference) ? (spec.reference as { kind: string }) : undefined,
        } as Parameters<typeof genomeSourceLocators>[0])
      : []
  );
  const additional: RendererCapability[] = [];
  if (locators.some((locator) => isRemoteGenomeSourceLocator(locator))) {
    additional.push('external-fetch:annotation');
  }
  const local = locators.some((locator) => locator.kind === 'local-file');
  if (local) additional.push('read-workspace');
  return {
    ...(additional.length > 0 ? { additionalRequiredCapabilities: additional } : {}),
    ...(local ? { requiresWorkspace: true } : {}),
  };
}

export function resolveImportEntitiesAuthorization(args: unknown): {
  additionalRequiredCapabilities?: readonly RendererCapability[];
} {
  if (!isRecord(args) || args.entityType === 'protein') return {};
  return { additionalRequiredCapabilities: ['edit-primers'] };
}

export function resolveDesignPrimersAuthorization(args: unknown): {
  additionalRequiredCapabilities?: readonly RendererCapability[];
} {
  const requestedModel = isRecord(args) && typeof args.tmModel === 'string' ? args.tmModel : null;
  const polymerase = isRecord(args) && typeof args.polymerase === 'string' ? args.polymerase : null;
  const model = resolvePrimerTmModelForCall({ tmModel: requestedModel, polymerase });
  return model.kind === 'neb' ? { additionalRequiredCapabilities: ['external-compute:tm'] } : {};
}

export function viewerIdForAuthorization(attrs: Structure3dAttrs): string {
  const source = (attrs.source ?? (attrs.uniprotId ? 'alphafold' : attrs.pdbId ? 'pdb' : 'url')) as
    | Structure3dSource
    | undefined;
  const props = source ? getMolstarPropsFromAttrs(source, attrs) : {};
  return getStructureKey(
    props.pdbId,
    props.uniprotId,
    props.url,
    props.structureData,
    props.structureIdentity
  );
}

export function resolveCoordinateMaterializationAuthorization(args: unknown): {
  additionalRequiredCapabilities?: readonly RendererCapability[];
} {
  const structureRef =
    isRecord(args) && typeof args.structureRef === 'string' ? args.structureRef : undefined;
  const candidates = Object.entries(useStructure3dStore.getState().expandedStructures).filter(
    ([registrationId, entry]) => {
      const structureId =
        entry.data.structureBinding?.structureId ??
        entry.data.structureArtifactRef?.structureId ??
        registrationId;
      const structureViewId = entry.data.structureViewIdentity?.structureViewId ?? registrationId;
      const bindingId = entry.data.structureBinding?.bindingId ?? null;
      const viewerId = viewerIdForAuthorization(entry.data);
      return (
        isRegisteredStructureAgentVisible({
          registrationId,
          structureId,
          structureViewId,
          bindingId,
          interactionKey: bindingId ?? structureId,
          viewerId,
          entry,
        }) &&
        (!structureRef ||
          registrationId === structureRef ||
          structureViewId === structureRef ||
          bindingId === structureRef ||
          structureId === structureRef ||
          viewerId === structureRef)
      );
    }
  );

  if (candidates.length !== 1) return {};

  const attrs = candidates[0][1].data;
  if (attrs.structureArtifactRef) return {};
  const source = (attrs.source ?? (attrs.uniprotId ? 'alphafold' : attrs.pdbId ? 'pdb' : 'url')) as
    | Structure3dSource
    | undefined;
  const props = source ? getMolstarPropsFromAttrs(source, attrs) : {};

  if (props.structureData) return {};
  if (props.url || props.pdbId || props.uniprotId || props.structureIdentity) {
    return { additionalRequiredCapabilities: ['external-fetch:structure'] };
  }

  return {};
}

export const assemblyListEditableFieldsSchema = z
  .object({
    designId: z.string().optional(),
  })
  .strict();

export const assemblySetEditableFieldSchema = z
  .object({
    designId: z.string().optional(),
    fieldId: z.string().min(1),
    value: z.union([z.number(), z.string()]),
    expectedDesignVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

export async function handleAssemblyListEditableFields(args: unknown) {
  return runDesignTool('ASSEMBLY_FIELDS_UNAVAILABLE', async () => {
    const parsed = assemblyListEditableFieldsSchema.parse(args);
    const design = getRendererDesign(parsed.designId);
    return toolSuccess({ ...listAssemblyEditableFields(design) });
  });
}

export async function handleAssemblySetEditableField(args: unknown) {
  return runDesignTool('ASSEMBLY_FIELD_EDIT_FAILED', async (effects) => {
    const parsed = assemblySetEditableFieldSchema.parse(args);
    const design = getRendererDesign(parsed.designId);
    const expectedDesignVersion = parsed.expectedDesignVersion ?? design.version;
    const result = applyAssemblyEditableFieldValue(design, {
      fieldId: parsed.fieldId,
      value: parsed.value,
      expectedDesignVersion,
    });
    if (result.status === 'noop')
      return toolSuccess({
        status: result.status,
        errors: result.errors,
        warnings: result.warnings,
        designId: design.id,
        designVersion: design.version,
      });
    if (result.status !== 'applied')
      return designToolFailure(
        'ASSEMBLY_FIELD_REJECTED',
        {
          status: result.status,
          code: result.errors?.[0]?.code,
          error: result.errors?.[0]?.message,
          errors: result.errors,
          warnings: result.warnings,
          designId: design.id,
          designVersion: design.version,
        },
        effects
      );
    effects.attemptedMutation();
    const committed = useDesignStore
      .getState()
      .commitWorkbenchDesign(design.id, result.nextDesign, expectedDesignVersion);
    if (!committed) {
      effects.unchanged();
      return designToolFailure(
        'STALE_DESIGN_VERSION',
        {
          error: 'The design changed before the assembly field edit could be committed.',
          retriable: true,
          designId: design.id,
        },
        effects
      );
    }
    effects.changed({
      kind: 'assembly-field-edited',
      designId: design.id,
      fieldId: parsed.fieldId,
    });
    return toolSuccess({
      status: result.status,
      designId: result.nextDesign.id,
      designVersion: result.nextDesign.version,
      appliedCommands: result.appliedCommands,
      warnings: result.warnings,
    });
  });
}

export function getRendererDesign(designId?: string) {
  const state = useDesignStore.getState();
  const id = designId ?? state.activeDesignId;
  if (!id) throw new Error('No active design is available.');
  const design = state.designs[id];
  if (!design) throw new Error(`Design not found: ${id}`);
  return design;
}

export async function handleStructureOpenDrawer(
  args: unknown,
  context: RendererToolExecutionContext
) {
  const { handleMolOpenDrawer } = await import('../structure-tools');
  return handleMolOpenDrawer(args, { folders: context.folders, abortSignal: context.abortSignal });
}

export async function handleStructureOpenTab(args: unknown, context: RendererToolExecutionContext) {
  const { handleMolOpenTab } = await import('../structure-tools');
  return handleMolOpenTab(args, { folders: context.folders, abortSignal: context.abortSignal });
}

export async function handleStructureCaptureScreenshot(args: unknown) {
  const { handleMolCaptureScreenshot } = await import('../structure-tools');
  return handleMolCaptureScreenshot(args);
}

export async function handleSequenceListAnnotations(
  args: unknown,
  context: RendererToolExecutionContext
) {
  return handleSeqListAnnotations(args, { folders: context.folders });
}

export async function handleExternalFetch(args: unknown, context: RendererToolExecutionContext) {
  if (!externalFetchTool.execute) {
    throw new Error('Renderer tool has no execute handler');
  }
  const options = {
    toolCallId: context.actionId,
    messages: [],
    abortSignal: context.abortSignal,
    grantedCapabilities: context.grantedCapabilities.filter(isExternalServiceCapability),
  };
  return externalFetchTool.execute(externalFetchSchema.parse(args), options);
}
