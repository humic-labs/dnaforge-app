import { resultTool, toolSuccess } from '../../agent-bridge/public/tool-result';
import { designToolFailure, runDesignTool } from './design-tool-result';
import { z } from 'zod';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import { resolveMocloFactoryWorkspaceRoot } from '../../design/public/materialize-design-artifact';
import {
  createMocloFactoryStageSelection,
  findMocloKitStage,
  schemaForMocloStage,
  mocloAssemblySchemaOptions,
  type MocloKitDefinition,
} from '../../design/public/moclo-kit-definition';
import {
  loadMocloSchemaDefinitions,
  saveMocloSchema,
} from '../../design/public/moclo-schema-catalog';
import {
  loadMocloCatalogCandidates,
  rankMocloCatalogCandidates,
  type LoadMocloCatalogCandidatesInput,
  type LoadMocloCatalogCandidatesResult,
} from '../../design/public/moclo-part-catalog';
import { useDesignStore } from '../../design/public/store';
import { reconcileMocloFactoryStageOutputsNow } from '../../design/public/moclo-stage-output-live';
import { projectAssemblySlots } from '../../design/public/slot-projection';
import { regionForSchemaSlot } from '../../design/public/assembly-slots';
import type { SequenceDesign } from '../../design/public/types';
import { createDesignMutationClaim } from './agent-mutation';
import { sequenceResourceUri } from './get-sequence';
import { CATALOG_ID_PATTERN } from '../../../shared/published-schema-patterns';

export const getMocloFactorySchema = z
  .object({
    designId: z
      .string()
      .min(1)
      .describe('Golden Gate design id returned by get_design, or waypoint://design/{id} URI.'),
  })
  .strict();

export const listMocloSchemasSchema = getMocloFactorySchema;

export const saveMocloSchemaSchema = z
  .object({
    designId: getMocloFactorySchema.shape.designId,
    expectedDesignVersion: z
      .number()
      .int()
      .nonnegative()
      .describe('Exact version of the schema preview the user reviewed.'),
    kitId: z
      .string()
      .regex(CATALOG_ID_PATTERN)
      .describe('Existing kit id, or a new custom kit id.'),
    kitName: z.string().min(1).optional().describe('Required when creating a new custom kit.'),
    expectedKitRevision: z
      .number()
      .int()
      .nonnegative()
      .describe('Kit revision from list_moclo_schemas, or 0 for a new custom kit.'),
    templateId: z
      .string()
      .min(1)
      .describe('Stable schema id within the kit. Reusing it explicitly replaces that template.'),
    name: z.string().min(1).describe('Reusable schema name approved by the user.'),
    description: z.string().min(1).describe('What this reusable layout is intended for.'),
  })
  .strict();

export const setMocloFactoryStageSchema = z
  .object({
    designId: z
      .string()
      .min(1)
      .describe('Golden Gate design id returned by get_design, or waypoint://design/{id} URI.'),
    expectedDesignVersion: z
      .number()
      .int()
      .nonnegative()
      .describe('Exact design version last read from get_design. Stale writes are refused.'),
    kitId: z.string().min(1).describe('Kit id returned by get_moclo_factory.'),
    recipeId: z.string().min(1).describe('Recipe id returned by get_moclo_factory.'),
    stageId: z.string().min(1).describe('Stage id returned by get_moclo_factory.'),
    runId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Existing factory run id when adding another stage design. Omit to reuse the design run or start a new one.'
      ),
  })
  .strict();

export const applyMocloSchemaSchema = z
  .object({
    designId: z
      .string()
      .min(1)
      .describe('Golden Gate design id returned by get_design, or waypoint://design/{id} URI.'),
    expectedDesignVersion: z
      .number()
      .int()
      .nonnegative()
      .describe('Exact design version last read from get_design. Stale writes are refused.'),
    kitId: z.string().min(1).describe('Kit id returned by list_moclo_schemas.'),
    schemaId: z
      .string()
      .min(1)
      .optional()
      .describe('Schema id returned by list_moclo_schemas. No recipe is needed.'),
    recipeId: z
      .string()
      .min(1)
      .optional()
      .describe('Legacy recipe id; use schemaId for new calls.'),
    stageId: z.string().min(1).optional().describe('Legacy stage id, paired with recipeId.'),
  })
  .strict();

export const searchMocloPartsSchema = z
  .object({
    designId: z
      .string()
      .min(1)
      .describe('Golden Gate design id returned by get_design, or waypoint://design/{id} URI.'),
    slotId: z.string().min(1).describe('Schema slot id returned by list_moclo_schemas.'),
    query: z
      .string()
      .max(200)
      .default('')
      .describe('Optional name, kit, part-type, ontology-role, or overhang search text.'),
    partType: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'Optional exact biological part-type label. Overhang compatibility remains primary.'
      ),
    includePhysicallyIncompatible: z
      .boolean()
      .default(false)
      .describe('Include digest fragments whose physical overhangs do not fit this slot.'),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

interface MocloFactoryToolDependencies {
  saveSchema?: typeof saveMocloSchema;
  loadDefinitions: (workspaceRoot: string) => Promise<MocloKitDefinition[]>;
  resolveWorkspaceRoot: (
    design: SequenceDesign,
    designs: readonly SequenceDesign[],
    folders: readonly WorkspaceFolder[]
  ) => Promise<string | null>;
  loadCandidates?: (
    input: LoadMocloCatalogCandidatesInput
  ) => Promise<LoadMocloCatalogCandidatesResult>;
}

const defaultDependencies: MocloFactoryToolDependencies = {
  loadDefinitions: loadMocloSchemaDefinitions,
  resolveWorkspaceRoot: resolveMocloFactoryWorkspaceRoot,
  loadCandidates: loadMocloCatalogCandidates,
};

function normalizeDesignId(input: string): string {
  if (!input.startsWith('waypoint://')) return input;
  try {
    const parsed = new URL(input);
    if (parsed.protocol === 'waypoint:' && parsed.hostname === 'design') {
      return decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    }
  } catch {
    return input;
  }
  return input;
}

function projectKit(definition: MocloKitDefinition) {
  return {
    id: definition.id,
    name: definition.name,
    revision: definition.revision,
    description: definition.description,
    memberCount: definition.members.length,
    partTypes: definition.partTypes.map((partType) => ({
      id: partType.id,
      label: partType.label,
      roleTerms: partType.roleTerms,
    })),
    citations: definition.citations,
    recipes: definition.recipes.map((recipe) => ({
      id: recipe.id,
      name: recipe.name,
      description: recipe.description,
      stages: recipe.stages.map((stage, stageIndex) => ({
        id: stage.id,
        name: stage.name,
        description: stage.description,
        stageNumber: stageIndex + 1,
        enzyme: stage.enzyme,
        topology: stage.topology,
        outputRole: stage.outputRole,
        slotCount: stage.slots.length,
        inputsFromStages: Array.from(
          new Set(
            stage.slots.flatMap((slot) =>
              slot.input.kind === 'stage-output' ? [slot.input.stageId] : []
            )
          )
        ),
        slots: stage.slots.map((slot) => ({
          id: slot.id,
          label: slot.label,
          outgoingOverhang: slot.outgoingOverhang,
          preferredRoles: slot.preferredRoles,
          input: slot.input,
        })),
      })),
    })),
  };
}

async function loadForDesign(
  designId: string,
  folders: readonly WorkspaceFolder[],
  dependencies: MocloFactoryToolDependencies
) {
  const design = useDesignStore.getState().designs[designId];
  if (!design) {
    return { status: 'rejected' as const, code: 'design-not-found' as const, design: null };
  }
  const workspaceRoot = await dependencies.resolveWorkspaceRoot(
    design,
    Object.values(useDesignStore.getState().designs),
    folders
  );
  if (!workspaceRoot) {
    return { status: 'rejected' as const, code: 'workspace-not-found' as const, design };
  }
  try {
    const definitions = await dependencies.loadDefinitions(workspaceRoot);
    return { status: 'ready' as const, design, workspaceRoot, definitions };
  } catch (error) {
    return {
      status: 'rejected' as const,
      code: 'definition-load-failed' as const,
      design,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createGetMocloFactoryTool(
  folders: readonly WorkspaceFolder[],
  dependencies: MocloFactoryToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Inspect the versioned MoClo kits and multi-stage recipes available to a Golden Gate design. ' +
      'Returns declared kit membership and ontology guidance, stage dependencies, schemas, enzymes, ' +
      'and the design’s current factory-run identity. Physical part compatibility is still computed ' +
      'from the real sequence and digest engine; the kit definition does not override it.',
    inputSchema: getMocloFactorySchema,
    execute: async ({ designId: rawDesignId }: z.infer<typeof getMocloFactorySchema>) =>
      runDesignTool('MOCLO_FACTORY_FAILED', async (effects) => {
        const designId = normalizeDesignId(rawDesignId);
        const loaded = await loadForDesign(designId, folders, dependencies);
        if (loaded.status !== 'ready') {
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            {
              status: loaded.status,
              code: loaded.code,
              designId,
              error:
                loaded.code === 'design-not-found'
                  ? `Design not found: ${designId}`
                  : loaded.code === 'workspace-not-found'
                    ? 'No writable project is open for this design.'
                    : loaded.error,
            },
            effects
          );
        }
        return toolSuccess({
          status: 'ready' as const,
          designId,
          designVersion: loaded.design.version,
          workspaceRoot: loaded.workspaceRoot,
          current: loaded.design.mocloFactory ?? null,
          kits: loaded.definitions.map(projectKit),
        });
      }),
  });
}

export function createListMocloSchemasTool(
  folders: readonly WorkspaceFolder[],
  dependencies: MocloFactoryToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'List the reusable MoClo schemas available to one Golden Gate assembly. Returns the exact ' +
      "kit and schema ids accepted by apply_moclo_schema, plus each schema's enzyme, " +
      'slot order, part roles, and overhangs. This does not create or select a factory run.',
    inputSchema: listMocloSchemasSchema,
    execute: async ({ designId: rawDesignId }: z.infer<typeof listMocloSchemasSchema>) =>
      runDesignTool('MOCLO_FACTORY_FAILED', async (effects) => {
        const designId = normalizeDesignId(rawDesignId);
        const loaded = await loadForDesign(designId, folders, dependencies);
        if (loaded.status !== 'ready') {
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            {
              status: loaded.status,
              code: loaded.code,
              designId,
              error:
                loaded.code === 'design-not-found'
                  ? `Design not found: ${designId}`
                  : loaded.code === 'workspace-not-found'
                    ? 'No owning project is available for this design.'
                    : loaded.error,
            },
            effects
          );
        }

        return toolSuccess({
          status: 'ready' as const,
          designId,
          designVersion: loaded.design.version,
          currentSchema: loaded.design.goldenGateSchema ?? null,
          kits: loaded.definitions.map(({ id, name, revision }) => ({ id, name, revision })),
          schemas: loaded.definitions.flatMap((definition) =>
            mocloAssemblySchemaOptions(definition)
              .filter((option) => option.topology === loaded.design.topology)
              .map(({ schema, topology }) => {
                const recipe = definition.recipes.find((candidate) =>
                  candidate.stages.some(
                    (stage) => schema.id === `${definition.id}:${candidate.id}:${stage.id}`
                  )
                );
                const stage = recipe?.stages.find(
                  (candidate) => schema.id === `${definition.id}:${recipe.id}:${candidate.id}`
                );
                return {
                  kitId: definition.id,
                  kitName: definition.name,
                  kitRevision: definition.revision,
                  schemaId: schema.id,
                  recipeId: recipe?.id,
                  recipeName: recipe?.name,
                  stageId: stage?.id,
                  name: schema.name,
                  enzyme: schema.enzyme,
                  topology,
                  slotCount: schema.slots.length,
                  slots: schema.slots,
                };
              })
          ),
        });
      }),
  });
}

export function createSaveMocloSchemaTool(
  folders: readonly WorkspaceFolder[],
  dependencies: MocloFactoryToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Save the reviewed schema of one Golden Gate assembly as a reusable project template. ' +
      'First use set_golden_gate_schema to preview explicit slot labels, roles and overhangs in the existing assembly pane, ' +
      'then obtain user approval before saving. This copies only the schema, never the DNA parts, primers or factory links. ' +
      'Use an existing kit or create a named custom kit. Existing assemblies are not changed. Read list_moclo_schemas for the kit revision.',
    inputSchema: saveMocloSchemaSchema,
    execute: async (input: z.infer<typeof saveMocloSchemaSchema>) =>
      runDesignTool('MOCLO_FACTORY_FAILED', async (effects) => {
        const designId = normalizeDesignId(input.designId);
        const loaded = await loadForDesign(designId, folders, dependencies);
        if (loaded.status !== 'ready')
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            {
              status: loaded.status,
              code: loaded.code,
              designId,
              error: 'The project schema definitions are unavailable.',
            },
            effects
          );
        const assertCurrent = () => {
          const current = useDesignStore.getState().designs[designId];
          if (!current || current.version !== input.expectedDesignVersion)
            throw new Error(
              'The assembly preview changed. Review its current schema before saving.'
            );
        };
        try {
          assertCurrent();
          if (!loaded.design.goldenGateSchema)
            throw new Error('Preview a schema with set_golden_gate_schema before saving it.');
          effects.attemptedMutation();
          const saved = await (dependencies.saveSchema ?? saveMocloSchema)(
            {
              projectRoot: loaded.workspaceRoot,
              kitId: input.kitId,
              kitName: input.kitName,
              expectedKitRevision: input.expectedKitRevision,
              templateId: input.templateId,
              name: input.name,
              description: input.description,
              schema: structuredClone(loaded.design.goldenGateSchema),
              topology: loaded.design.topology,
            },
            undefined,
            assertCurrent
          );
          return toolSuccess({
            status: 'saved' as const,
            designId,
            designVersion: input.expectedDesignVersion,
            ...saved,
          });
        } catch (error) {
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            {
              status: 'rejected' as const,
              designId,
              error: error instanceof Error ? error.message : String(error),
            },
            effects
          );
        }
      }),
  });
}

export function createSetMocloFactoryStageTool(
  folders: readonly WorkspaceFolder[],
  dependencies: MocloFactoryToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Select one stage from a project MoClo factory recipe for a Golden Gate design. This applies ' +
      'the exact versioned stage schema and records the factory run/stage identity through the same ' +
      'command used by the UI. Call get_moclo_factory and get_design first. Prior stage outputs remain ' +
      'explicit dependencies; this tool never invents products or overhangs.',
    inputSchema: setMocloFactoryStageSchema,
    execute: async (
      input: z.infer<typeof setMocloFactoryStageSchema>,
      context?: { toolCallId?: string }
    ) =>
      runDesignTool('MOCLO_FACTORY_FAILED', async (effects) => {
        const designId = normalizeDesignId(input.designId);
        const loaded = await loadForDesign(designId, folders, dependencies);
        if (loaded.status !== 'ready') {
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            {
              status: loaded.status,
              code: loaded.code,
              designId,
              error:
                loaded.code === 'design-not-found'
                  ? `Design not found: ${designId}`
                  : loaded.code === 'workspace-not-found'
                    ? 'No writable project is open for this design.'
                    : loaded.error,
            },
            effects
          );
        }

        const definition = loaded.definitions.find((candidate) => candidate.id === input.kitId);
        if (!definition) {
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            {
              status: 'rejected' as const,
              code: 'kit-not-found' as const,
              designId,
              currentVersion: loaded.design.version,
              error: `MoClo kit “${input.kitId}” is not defined in this project.`,
            },
            effects
          );
        }
        const recipe = definition.recipes.find((candidate) => candidate.id === input.recipeId);
        if (!recipe) {
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            {
              status: 'rejected' as const,
              code: 'recipe-not-found' as const,
              designId,
              currentVersion: loaded.design.version,
              error: `MoClo kit “${definition.id}” has no recipe “${input.recipeId}”.`,
            },
            effects
          );
        }
        let stage;
        try {
          stage = findMocloKitStage(definition, recipe.id, input.stageId);
        } catch (error) {
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            {
              status: 'rejected' as const,
              code: 'stage-not-found' as const,
              designId,
              currentVersion: loaded.design.version,
              error: error instanceof Error ? error.message : String(error),
            },
            effects
          );
        }

        const selection = createMocloFactoryStageSelection(definition, recipe, stage);
        const runId =
          input.runId ?? loaded.design.mocloFactory?.runId ?? `moclo-${crypto.randomUUID()}`;
        const beforeVersion = loaded.design.version;
        effects.attemptedMutation();
        const result = useDesignStore
          .getState()
          .setMocloFactoryStage(designId, selection, runId, input.expectedDesignVersion);
        const current = useDesignStore.getState().designs[designId] ?? loaded.design;
        if (result.status === 'rejected') {
          effects.unchanged();
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            {
              ...result,
              error: result.message,
              designId,
              currentVersion: current.version,
            },
            effects
          );
        }

        if (result.status === 'applied')
          effects.changed({ kind: 'moclo-stage-selected', designId });
        else effects.unchanged();
        await reconcileMocloFactoryStageOutputsNow();
        const reconciled = useDesignStore.getState().designs[designId] ?? current;
        const changed = result.status === 'applied' || reconciled.version !== current.version;
        return toolSuccess({
          status: result.status,
          designId,
          previousVersion: beforeVersion,
          designVersion: reconciled.version,
          runId,
          kit: { id: definition.id, name: definition.name, revision: definition.revision },
          recipe: { id: recipe.id, name: recipe.name },
          stage: {
            id: stage.id,
            name: stage.name,
            enzyme: stage.enzyme,
            slotCount: stage.slots.length,
            inputsFromStages: Array.from(
              new Set(
                stage.slots.flatMap((slot) =>
                  slot.input.kind === 'stage-output' ? [slot.input.stageId] : []
                )
              )
            ),
          },
          mutation: createDesignMutationClaim({
            operationId: context?.toolCallId,
            toolName: 'set_moclo_factory_stage',
            effect: 'set_moclo_factory_stage',
            designId,
            beforeVersion,
            afterVersion: reconciled.version,
            changed,
            expected: {
              runId,
              kitId: definition.id,
              kitRevision: definition.revision,
              recipeId: recipe.id,
              stageId: stage.id,
              schemaId: selection.schema.id,
            },
          }),
        });
      }),
  });
}

export function createApplyMocloSchemaTool(
  folders: readonly WorkspaceFolder[],
  dependencies: MocloFactoryToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Apply one reusable project MoClo schema to a Golden Gate assembly without creating a ' +
      'multi-stage factory run. The schema fixes the slot count, order, enzyme, roles, and expected ' +
      'overhangs. Changing the schema starts over with empty slots. A populated draft returns confirmation-required so the user can change it in the assembly pane.',
    inputSchema: applyMocloSchemaSchema,
    execute: async (
      input: z.infer<typeof applyMocloSchemaSchema>,
      context?: { toolCallId?: string }
    ) =>
      runDesignTool('MOCLO_FACTORY_FAILED', async (effects) => {
        const designId = normalizeDesignId(input.designId);
        const loaded = await loadForDesign(designId, folders, dependencies);
        if (loaded.status !== 'ready') {
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            {
              status: loaded.status,
              code: loaded.code,
              designId,
              error:
                loaded.code === 'design-not-found'
                  ? `Design not found: ${designId}`
                  : loaded.code === 'workspace-not-found'
                    ? 'No owning project is available for this design.'
                    : loaded.error,
            },
            effects
          );
        }
        const definition = loaded.definitions.find((candidate) => candidate.id === input.kitId);
        if (!definition) {
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            {
              status: 'rejected' as const,
              code: 'kit-not-found' as const,
              designId,
              error: `MoClo kit “${input.kitId}” is not defined in this project.`,
            },
            effects
          );
        }
        let schema;
        try {
          if (input.schemaId) {
            schema = mocloAssemblySchemaOptions(definition).find(
              (option) =>
                option.schema.id === input.schemaId && option.topology === loaded.design.topology
            )?.schema;
          } else if (input.recipeId && input.stageId) {
            schema = schemaForMocloStage(
              definition,
              findMocloKitStage(definition, input.recipeId, input.stageId)
            );
          }
          if (!schema) throw new Error('Choose a schemaId returned by list_moclo_schemas.');
        } catch (error) {
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            {
              status: 'rejected' as const,
              code: 'schema-not-found' as const,
              designId,
              error: error instanceof Error ? error.message : String(error),
            },
            effects
          );
        }

        const beforeVersion = loaded.design.version;
        effects.attemptedMutation();
        const result = useDesignStore
          .getState()
          .setGoldenGateSchema(designId, schema, input.expectedDesignVersion);
        const current = useDesignStore.getState().designs[designId] ?? loaded.design;
        if (result.status === 'rejected') {
          effects.unchanged();
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            { ...result, error: result.message, designId, currentVersion: current.version },
            effects
          );
        }
        const changed = result.status === 'applied';
        if (changed) effects.changed({ kind: 'moclo-schema-applied', designId });
        else effects.unchanged();
        return toolSuccess({
          status: result.status,
          designId,
          previousVersion: beforeVersion,
          designVersion: current.version,
          schema,
          slotCount: schema.slots.length,
          mutation: createDesignMutationClaim({
            operationId: context?.toolCallId,
            toolName: 'apply_moclo_schema',
            effect: 'set_golden_gate_schema',
            designId,
            beforeVersion,
            afterVersion: current.version,
            changed,
            expected: {
              schemaId: schema.id,
              schemaRevision: schema.revision,
              slotCount: schema.slots.length,
            },
          }),
        });
      }),
  });
}

export function createSearchMocloPartsTool(
  folders: readonly WorkspaceFolder[],
  dependencies: MocloFactoryToolDependencies = defaultDependencies
) {
  return resultTool({
    description:
      'Search the same digest-derived, overhang-compatible MoClo part candidates shown by the assembly UI ' +
      'for one exact slot. Results identify the stable sequence document to pass to virtual_digest and ' +
      'return the target region id and occupant fingerprint required by place_digest_fragment. ' +
      'Stage-output slots refuse kit-part substitution instead of pretending a prior-stage product exists.',
    inputSchema: searchMocloPartsSchema,
    execute: async (input: z.infer<typeof searchMocloPartsSchema>) =>
      runDesignTool('MOCLO_FACTORY_FAILED', async (effects) => {
        const designId = normalizeDesignId(input.designId);
        const loaded = await loadForDesign(designId, folders, dependencies);
        if (loaded.status !== 'ready') {
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            {
              status: loaded.status,
              code: loaded.code,
              designId,
              error:
                loaded.code === 'design-not-found'
                  ? `Design not found: ${designId}`
                  : loaded.code === 'workspace-not-found'
                    ? 'No writable project is open for this design.'
                    : loaded.error,
            },
            effects
          );
        }

        const schema = loaded.design.goldenGateSchema;
        if (!schema) {
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            {
              status: 'rejected' as const,
              code: 'schema-not-selected' as const,
              designId,
              error: 'Select a MoClo schema before searching its slots.',
            },
            effects
          );
        }
        const factory = loaded.design.mocloFactory;
        const slotIndex = schema.slots.findIndex((slot) => slot.id === input.slotId);
        if (slotIndex < 0) {
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            {
              status: 'rejected' as const,
              code: 'slot-not-found' as const,
              designId,
              error: `Schema “${schema.name}” has no slot “${input.slotId}”.`,
            },
            effects
          );
        }
        const schemaSlot = schema.slots[slotIndex];
        if (!schemaSlot) {
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            { status: 'rejected' as const, code: 'slot-not-found' as const, designId },
            effects
          );
        }
        if (factory) {
          const definition = loaded.definitions.find(
            (candidate) =>
              candidate.id === factory.kitId && candidate.revision === factory.kitRevision
          );
          if (!definition) {
            return designToolFailure(
              'MOCLO_FACTORY_FAILED',
              {
                status: 'rejected' as const,
                code: 'kit-revision-not-found' as const,
                designId,
                error: `MoClo kit ${factory.kitId}@${factory.kitRevision} is not available in this project.`,
              },
              effects
            );
          }
          const stage = findMocloKitStage(definition, factory.recipeId, factory.stageId);
          const stageSlot = stage.slots.find((slot) => slot.id === input.slotId);
          if (stageSlot?.input.kind === 'stage-output') {
            return designToolFailure(
              'MOCLO_FACTORY_FAILED',
              {
                status: 'rejected' as const,
                code: 'stage-output-required' as const,
                designId,
                slotId: stageSlot.id,
                requiredStageId: stageSlot.input.stageId,
                error: `Slot “${stageSlot.label}” requires an output from stage “${stageSlot.input.stageId}”, not a kit part.`,
              },
              effects
            );
          }
        }

        const catalogLoader = dependencies.loadCandidates ?? loadMocloCatalogCandidates;
        const catalog = await catalogLoader({
          workspaceRoot: loaded.workspaceRoot,
          enzymeName: schema.enzyme,
          kitDefinitions: loaded.definitions,
        });
        const ranked = rankMocloCatalogCandidates({
          candidates: catalog.candidates,
          schema,
          slotIndex,
          topology: loaded.design.topology,
          query: input.query ?? '',
          partTypeFilter: input.partType ?? null,
          includePhysicallyIncompatible: input.includePhysicallyIncompatible ?? false,
        });
        const candidates = ranked.slice(0, input.limit ?? 20).map((candidate) => ({
          candidateId: candidate.id,
          name: candidate.name,
          componentLabel: candidate.componentLabel ?? null,
          documentId: candidate.source.entityId,
          resourceUri: sequenceResourceUri(candidate.source.entityId),
          kit: candidate.kit,
          kitMemberId: candidate.kitMemberId,
          kitPartTypeId: candidate.kitPartTypeId,
          fragment: {
            index: candidate.fragment.index,
            length: candidate.fragment.length,
            upstreamOverhang: candidate.upstreamOverhang,
            downstreamOverhang: candidate.downstreamOverhang,
            hasInternalSites: candidate.fragment.hasInternalSites,
          },
          roleEvidence: candidate.roleEvidence,
          compatibility: candidate.compatibility,
        }));
        const targetRegion = regionForSchemaSlot(loaded.design, schemaSlot.id);
        const targetSlot =
          targetRegion &&
          projectAssemblySlots(loaded.design).find((slot) => slot.regionId === targetRegion.id);
        if (!targetSlot) {
          return designToolFailure(
            'MOCLO_FACTORY_FAILED',
            {
              status: 'rejected' as const,
              code: 'slot-not-found' as const,
              designId,
              error: `No assembly position is linked to schema slot “${schemaSlot.id}”.`,
            },
            effects
          );
        }

        return toolSuccess({
          status: 'ready' as const,
          designId,
          designVersion: loaded.design.version,
          factory,
          enzyme: schema.enzyme,
          slot: {
            id: schemaSlot.id,
            label: schemaSlot.label,
            preferredRoles: schemaSlot.preferredRoles,
          },
          targetSlot,
          resultCount: candidates.length,
          totalMatched: ranked.length,
          skippedSourceCount: catalog.skippedSourceCount,
          candidates,
          nextAction:
            'Call virtual_digest with a candidate documentId and this enzyme; then call place_digest_fragment with the chosen returned fragment plus targetSlot.regionId and targetSlot.occupantFingerprint.',
        });
      }),
  });
}
