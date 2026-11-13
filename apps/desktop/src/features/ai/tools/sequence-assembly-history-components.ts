import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { findContainingPathBoundary } from '../../../shared/path-boundary';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { resolveAcceptedAssemblyRecord } from '../../assembly/public/accepted-record-reader';
import {
  inspectHistoricalAssemblyStageTarget,
  listHistoricalAssemblyComponents,
  previewHistoricalAssemblyComponentStage,
  stageHistoricalAssemblyComponents,
} from '../../assembly/public/historical-component-workflow';

const id = z.string().trim().min(1).max(256);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sourcePin = {
  acceptedAssemblyVersionId: id,
  canonicalDraftChecksum: id,
  componentId: z.string().min(1).max(1024),
  componentDigest: digest,
};
const source = z.discriminatedUnion('kind', [
  z.object({ ...sourcePin, kind: z.literal('region'), regionId: id }).strict(),
  z.object({
    ...sourcePin, kind: z.literal('spacer'), spacerId: id,
    leftRegionId: id, rightRegionId: id,
  }).strict(),
  z.object({
    ...sourcePin, kind: z.literal('join'), method: z.enum(['gibson', 'goldengate']),
    leftRegionId: id, rightRegionId: id,
  }).strict(),
  z.object({
    ...sourcePin, kind: z.literal('primer-pair'), regionId: id,
    directions: z.tuple([z.literal('forward'), z.literal('reverse')]),
  }).strict(),
]);
const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('region'), regionId: id }).strict(),
  z.object({ kind: z.literal('spacer'), leftRegionId: id, rightRegionId: id }).strict(),
  z.object({ kind: z.literal('join'), leftRegionId: id, rightRegionId: id }).strict(),
  z.object({ kind: z.literal('primer-pair'), regionId: id }).strict(),
]);
const selection = z.object({ source, target }).strict();

export const listHistoricalAssemblyComponentsSchema = z.object({
  constructId: id,
  referenceAcceptedAssemblyVersionId: id.optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();

export const inspectHistoricalAssemblyStageTargetSchema = z.object({
  constructId: id,
  baseAcceptedAssemblyVersionId: id,
}).strict();

export const previewHistoricalAssemblyComponentStageSchema =
  inspectHistoricalAssemblyStageTargetSchema.extend({
    expectedDesignVersion: z.number().int().min(0),
    expectedDraftDigest: digest,
    selections: z.array(selection).min(1).max(100),
  }).strict();

export const stageHistoricalAssemblyComponentsSchema =
  previewHistoricalAssemblyComponentStageSchema.extend({
    reopenIdempotencyKey: z.string().trim().min(1).max(200),
  }).strict();

type Dependencies = {
  resolve: typeof resolveAcceptedAssemblyRecord;
  list: typeof listHistoricalAssemblyComponents;
  inspect: typeof inspectHistoricalAssemblyStageTarget;
  preview: typeof previewHistoricalAssemblyComponentStage;
  stage: typeof stageHistoricalAssemblyComponents;
};

const defaults: Dependencies = {
  resolve: resolveAcceptedAssemblyRecord,
  list: listHistoricalAssemblyComponents,
  inspect: inspectHistoricalAssemblyStageTarget,
  preview: previewHistoricalAssemblyComponentStage,
  stage: stageHistoricalAssemblyComponents,
};

async function requireOpenPackage(
  folders: WorkspaceFolder[],
  deps: Dependencies,
  constructId: string,
  acceptedAssemblyVersionId?: string
): Promise<void> {
  const record = await deps.resolve({ constructId, acceptedAssemblyVersionId });
  if (!findContainingPathBoundary(
    folders.filter((folder) => !folder.pinned), record.packageRoot
  )) {
    throw new Error('The assembly package is outside the open writable project.');
  }
}

function failure(error: unknown, mutationStarted = false) {
  return toolFailure({
    code: 'ASSEMBLY_HISTORY_UNAVAILABLE',
    error: error instanceof Error ? error.message : String(error),
    retriable: true,
    stateChanged: mutationStarted ? 'unknown' : false,
    partialEffects: mutationStarted ? ['package-owned assembly copy may have been opened'] : [],
  });
}

export function createListHistoricalAssemblyComponentsTool(
  folders: WorkspaceFolder[], deps: Dependencies = defaults
) {
  return resultTool({
    description: 'List verified saved assembly pieces by immutable version and component identity.',
    inputSchema: listHistoricalAssemblyComponentsSchema,
    execute: async (input) => {
      try {
        await requireOpenPackage(folders, deps, input.constructId,
          input.referenceAcceptedAssemblyVersionId);
        const catalog = await deps.list(input);
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 50;
        return toolSuccess({
          constructId: input.constructId,
          total: catalog.components.length,
          offset,
          components: catalog.components.slice(offset, offset + limit),
          nextOffset: offset + limit < catalog.components.length ? offset + limit : null,
          unavailable: catalog.unavailable,
        });
      } catch (error) {
        return failure(error);
      }
    },
  });
}

export function createInspectHistoricalAssemblyStageTargetTool(
  folders: WorkspaceFolder[], deps: Dependencies = defaults
) {
  return resultTool({
    description: 'Inspect the one package-owned assembly copy and its exact current stage slots.',
    inputSchema: inspectHistoricalAssemblyStageTargetSchema,
    execute: async (input) => {
      try {
        await requireOpenPackage(folders, deps, input.constructId,
          input.baseAcceptedAssemblyVersionId);
        const inspected = await deps.inspect(input);
        const { draftPath: _privatePath, ...publicResult } = inspected;
        return toolSuccess(publicResult);
      } catch (error) {
        return failure(error);
      }
    },
  });
}

export function createPreviewHistoricalAssemblyComponentStageTool(
  folders: WorkspaceFolder[], deps: Dependencies = defaults
) {
  return resultTool({
    description: 'Check a selected combination of saved assembly pieces without creating or editing a copy.',
    inputSchema: previewHistoricalAssemblyComponentStageSchema,
    execute: async (input) => {
      try {
        await requireOpenPackage(folders, deps, input.constructId,
          input.baseAcceptedAssemblyVersionId);
        const preview = await deps.preview(input);
        if (preview.status === 'blocked') return toolSuccess(preview);
        const { draftPath: _privatePath, ...publicTarget } = preview.target;
        return toolSuccess({ ...preview, target: publicTarget });
      } catch (error) {
        return failure(error);
      }
    },
  });
}

export function createStageHistoricalAssemblyComponentsTool(
  folders: WorkspaceFolder[], deps: Dependencies = defaults
) {
  return resultTool({
    description: 'Stage exactly selected historical pieces in the same package-owned assembly copy.',
    inputSchema: stageHistoricalAssemblyComponentsSchema,
    execute: async (input) => {
      let mutationStarted = false;
      try {
        await requireOpenPackage(folders, deps, input.constructId,
          input.baseAcceptedAssemblyVersionId);
        mutationStarted = true;
        const result = await deps.stage({ ...input, actor: 'agent' });
        const { draftPath: _privatePath, ...publicResult } = result;
        return toolSuccess(publicResult);
      } catch (error) {
        return failure(error, mutationStarted);
      }
    },
  });
}
