import CIDAR_RAW from '../../../resources/sample-workspaces/standard-samples/workspace/.forge/moclo-kits/cidar.json?raw';
import YTK_RAW from '../../../resources/sample-workspaces/standard-samples/workspace/.forge/moclo-kits/ytk.json?raw';
import { platform } from '../../platform';
import { looksLikeWorkspacePath } from '../../shared/resolve-entity-path';
import { validateGoldenGateSchema } from './golden-gate-schema';
import type {
  GoldenGateAssemblySchema,
  GoldenGateRoleEvidence,
  GoldenGateRoleTerm,
  GoldenGateSchemaSlot,
} from './golden-gate-schema';
import { GOLDEN_GATE_ENZYME_NAMES, type GoldenGateEnzyme } from './types';
import type { MocloFactoryStageInput } from './types';

export const MOCLO_KIT_SCHEMA = 'dnaforge.moclo-kit' as const;
export const MOCLO_KIT_FORMAT_VERSION = 3 as const;
export const MOCLO_KIT_DIRECTORY = '.forge/moclo-kits' as const;
const bundledDocuments = [CIDAR_RAW, YTK_RAW];

export interface MocloKitCitation {
  label: string;
  doi?: string;
  pmid?: string;
  url?: string;
}

export interface MocloKitPartType {
  id: string;
  label: string;
  roleTerms: GoldenGateRoleTerm[];
}

export interface MocloKitMember {
  id: string;
  name: string;
  sequencePackageId: string;
  partTypeId?: string;
}

export type MocloStageSlotInput = { kind: 'kit-part' } | { kind: 'stage-output'; stageId: string };

export interface MocloKitStageSlot extends GoldenGateSchemaSlot {
  input: MocloStageSlotInput;
}

export interface MocloKitAssemblySchema {
  id: string;
  name: string;
  description: string;
  enzyme: GoldenGateEnzyme;
  topology: 'linear' | 'circular';
  slots: GoldenGateSchemaSlot[];
}

export interface MocloKitStageDefinition extends Omit<MocloKitAssemblySchema, 'slots'> {
  outputRole: GoldenGateRoleTerm;
  slots: MocloKitStageSlot[];
}

export interface MocloKitRecipe {
  id: string;
  name: string;
  description: string;
  stages: MocloKitStageDefinition[];
}

export interface MocloKitDefinition {
  schema: typeof MOCLO_KIT_SCHEMA;
  formatVersion: typeof MOCLO_KIT_FORMAT_VERSION;
  id: string;
  name: string;
  revision: number;
  description: string;
  citations: MocloKitCitation[];
  partTypes: MocloKitPartType[];
  members: MocloKitMember[];
  recipes: MocloKitRecipe[];
  assemblySchemas: MocloKitAssemblySchema[];
}

export interface MocloFactoryStageSelection {
  kitId: string;
  kitRevision: number;
  recipeId: string;
  stageId: string;
  schema: GoldenGateAssemblySchema;
  stageInputs: MocloFactoryStageInput[];
}

export interface MocloKitMembership {
  kit: { id: string; name: string };
  definition: MocloKitDefinition;
  member: MocloKitMember;
  partType: MocloKitPartType | null;
  roleEvidence: GoldenGateRoleEvidence[];
}

export interface MocloKitReferenceIdentity {
  packageId: string;
}

export interface MocloKitFileSystem {
  exists(path: string): Promise<boolean>;
  readDir(path: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>>;
  readTextFile(path: string): Promise<string>;
}

export interface MocloKitDefinitionLoadIssue {
  source: string;
  message: string;
  kitId?: string;
}

export interface MocloKitDefinitionInventory {
  definitions: MocloKitDefinition[];
  issues: MocloKitDefinitionLoadIssue[];
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, context: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, context);
}

function arrayValue(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  return value;
}

function positiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${context} must be a positive integer.`);
  }
  return Number(value);
}

function uniqueIds(values: readonly { id: string }[], context: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) throw new Error(`${context} contains duplicate id “${value.id}”.`);
    seen.add(value.id);
  }
}

function parseRoleTerm(value: unknown, context: string): GoldenGateRoleTerm {
  const source = record(value, context);
  return {
    ...(source.id === undefined ? {} : { id: stringValue(source.id, `${context}.id`) }),
    label: stringValue(source.label, `${context}.label`),
  };
}

function parseCitation(value: unknown, context: string): MocloKitCitation {
  const source = record(value, context);
  return {
    label: stringValue(source.label, `${context}.label`),
    ...(optionalString(source.doi, `${context}.doi`) ? { doi: String(source.doi).trim() } : {}),
    ...(optionalString(source.pmid, `${context}.pmid`) ? { pmid: String(source.pmid).trim() } : {}),
    ...(optionalString(source.url, `${context}.url`) ? { url: String(source.url).trim() } : {}),
  };
}

function parsePartType(value: unknown, context: string): MocloKitPartType {
  const source = record(value, context);
  return {
    id: stringValue(source.id, `${context}.id`),
    label: stringValue(source.label, `${context}.label`),
    roleTerms: arrayValue(source.roleTerms ?? [], `${context}.roleTerms`).map((term, index) =>
      parseRoleTerm(term, `${context}.roleTerms[${index}]`)
    ),
  };
}

function parseMember(value: unknown, context: string): MocloKitMember {
  const source = record(value, context);
  if (source.sequenceEntityId !== undefined || source.workspacePath !== undefined) {
    throw new Error(
      `${context} must identify a managed sequence package by sequencePackageId, never by a catalog entity or project path.`
    );
  }
  const partTypeId = optionalString(source.partTypeId, `${context}.partTypeId`);
  const sequencePackageId = stringValue(source.sequencePackageId, `${context}.sequencePackageId`);
  if (looksLikeWorkspacePath(sequencePackageId)) {
    throw new Error(`${context}.sequencePackageId must be a stable package ID, never a path.`);
  }
  return {
    id: stringValue(source.id, `${context}.id`),
    name: stringValue(source.name, `${context}.name`),
    sequencePackageId,
    ...(partTypeId ? { partTypeId } : {}),
  };
}

function parseSlotInput(value: unknown, context: string): MocloStageSlotInput {
  const source = record(value, context);
  const kind = stringValue(source.kind, `${context}.kind`);
  if (kind === 'kit-part') return { kind };
  if (kind === 'stage-output') {
    return { kind, stageId: stringValue(source.stageId, `${context}.stageId`) };
  }
  throw new Error(`${context}.kind must be “kit-part” or “stage-output”.`);
}

function parseSchemaSlot(value: unknown, context: string): GoldenGateSchemaSlot {
  const source = record(value, context);
  const overhang = source.outgoingOverhang;
  if (overhang !== null && typeof overhang !== 'string') {
    throw new Error(`${context}.outgoingOverhang must be a string or null.`);
  }
  return {
    id: stringValue(source.id, `${context}.id`),
    label: stringValue(source.label, `${context}.label`),
    outgoingOverhang: overhang === null ? null : overhang.trim().toUpperCase(),
    preferredRoles: arrayValue(source.preferredRoles ?? [], `${context}.preferredRoles`).map(
      (role, index) => parseRoleTerm(role, `${context}.preferredRoles[${index}]`)
    ),
  };
}

function parseStageSlot(value: unknown, context: string): MocloKitStageSlot {
  return {
    ...parseSchemaSlot(value, context),
    input: parseSlotInput(record(value, context).input, `${context}.input`),
  };
}

function parseAssemblySchema(value: unknown, context: string): MocloKitAssemblySchema {
  const source = record(value, context);
  const enzyme = stringValue(source.enzyme, `${context}.enzyme`);
  if (!GOLDEN_GATE_ENZYME_NAMES.includes(enzyme as GoldenGateEnzyme)) {
    throw new Error(`${context}.enzyme “${enzyme}” is not a supported Golden Gate enzyme.`);
  }
  const topology = stringValue(source.topology, `${context}.topology`);
  if (topology !== 'linear' && topology !== 'circular') {
    throw new Error(`${context}.topology must be “linear” or “circular”.`);
  }
  const stage: MocloKitAssemblySchema = {
    id: stringValue(source.id, `${context}.id`),
    name: stringValue(source.name, `${context}.name`),
    description: stringValue(source.description, `${context}.description`),
    enzyme: enzyme as GoldenGateEnzyme,
    topology,
    slots: arrayValue(source.slots, `${context}.slots`).map((slot, index) =>
      parseSchemaSlot(slot, `${context}.slots[${index}]`)
    ),
  };
  uniqueIds(stage.slots, `${context}.slots`);
  return stage;
}

function parseStage(value: unknown, context: string): MocloKitStageDefinition {
  const source = record(value, context);
  return {
    ...parseAssemblySchema(value, context),
    outputRole: parseRoleTerm(source.outputRole, `${context}.outputRole`),
    slots: arrayValue(source.slots, `${context}.slots`).map((slot, index) =>
      parseStageSlot(slot, `${context}.slots[${index}]`)
    ),
  };
}

function parseRecipe(value: unknown, context: string): MocloKitRecipe {
  const source = record(value, context);
  const recipe: MocloKitRecipe = {
    id: stringValue(source.id, `${context}.id`),
    name: stringValue(source.name, `${context}.name`),
    description: stringValue(source.description, `${context}.description`),
    stages: arrayValue(source.stages, `${context}.stages`).map((stage, index) =>
      parseStage(stage, `${context}.stages[${index}]`)
    ),
  };
  uniqueIds(recipe.stages, `${context}.stages`);
  return recipe;
}

function validateDefinition(definition: MocloKitDefinition, sourceLabel: string): void {
  uniqueIds(definition.partTypes, `${sourceLabel}.partTypes`);
  uniqueIds(definition.members, `${sourceLabel}.members`);
  uniqueIds(definition.recipes, `${sourceLabel}.recipes`);
  uniqueIds(definition.assemblySchemas ?? [], `${sourceLabel}.assemblySchemas`);
  for (const option of mocloAssemblySchemaOptions(definition)) {
    const validation = validateGoldenGateSchema(option.schema, option.topology);
    if (!validation.ok) {
      throw new Error(
        `${sourceLabel} schema “${option.schema.id}” is invalid: ${validation.issues.map((issue) => issue.message).join(' ')}`
      );
    }
  }

  const sequencePackageIds = new Set<string>();
  const partTypeIds = new Set(definition.partTypes.map((partType) => partType.id));
  for (const member of definition.members) {
    if (sequencePackageIds.has(member.sequencePackageId)) {
      throw new Error(
        `${sourceLabel}.members contains duplicate sequencePackageId “${member.sequencePackageId}”.`
      );
    }
    if (member.partTypeId !== undefined && !partTypeIds.has(member.partTypeId)) {
      throw new Error(
        `${sourceLabel} member “${member.id}” references unknown part type “${member.partTypeId}”.`
      );
    }
    sequencePackageIds.add(member.sequencePackageId);
  }

  for (const recipe of definition.recipes) {
    const precedingStages = new Set<string>();
    for (const stage of recipe.stages) {
      for (const slot of stage.slots) {
        if (slot.input.kind === 'stage-output' && !precedingStages.has(slot.input.stageId)) {
          throw new Error(
            `${sourceLabel} stage “${stage.id}” references unavailable prior stage “${slot.input.stageId}”.`
          );
        }
      }
      const validation = validateGoldenGateSchema(
        schemaForMocloStage(definition, stage),
        stage.topology
      );
      if (!validation.ok) {
        throw new Error(
          `${sourceLabel} stage “${stage.id}” has an invalid Golden Gate schema: ${validation.issues
            .map((issue) => issue.message)
            .join(' ')}`
        );
      }
      precedingStages.add(stage.id);
    }
  }
}

function migrateMocloKitV2(definition: MocloKitDefinition): MocloKitDefinition {
  const bundled = bundledDocuments
    .map((text) => record(JSON.parse(text), 'Bundled MoClo kit'))
    .find((kit) => kit.id === definition.id);
  const templates = [...definition.assemblySchemas];
  const recipes = [...definition.recipes];
  if (bundled) {
    for (const item of arrayValue(bundled.assemblySchemas ?? [], 'Bundled schemas')) {
      const template = parseAssemblySchema(item, 'Bundled schema');
      if (!templates.some((existing) => existing.id === template.id)) templates.push(template);
    }
    for (const item of arrayValue(bundled.recipes, 'Bundled recipes')) {
      const recipe = parseRecipe(item, 'Bundled recipe');
      if (!recipes.some((existing) => existing.id === recipe.id)) recipes.push(recipe);
    }
  }
  for (const recipe of recipes) {
    for (const stage of recipe.stages) {
      const id = `${recipe.id}:${stage.id}`;
      if (templates.some((template) => template.id === id)) continue;
      templates.push({
        id,
        name: stage.outputRole.label,
        description: stage.description,
        enzyme: stage.enzyme,
        topology: stage.topology,
        slots: stage.slots.map(({ input: _input, ...slot }) => slot),
      });
    }
  }
  return { ...definition, recipes, assemblySchemas: templates };
}

export function bundledMocloKitDefinitions(): MocloKitDefinition[] {
  return bundledDocuments.map((text) => ({ ...parseMocloKitDefinition(text), members: [] }));
}

export function parseMocloKitDefinition(
  text: string,
  sourceLabel = 'MoClo kit'
): MocloKitDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${sourceLabel} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const source = record(parsed, sourceLabel);
  const schema = stringValue(source.schema, `${sourceLabel}.schema`);
  if (schema !== MOCLO_KIT_SCHEMA) {
    throw new Error(`${sourceLabel} uses unsupported schema “${schema}”.`);
  }
  const formatVersion = positiveInteger(source.formatVersion, `${sourceLabel}.formatVersion`);
  if (formatVersion !== 2 && formatVersion !== MOCLO_KIT_FORMAT_VERSION) {
    throw new Error(`${sourceLabel} uses unsupported MoClo kit format version ${formatVersion}.`);
  }

  const definition: MocloKitDefinition = {
    schema: MOCLO_KIT_SCHEMA,
    formatVersion: MOCLO_KIT_FORMAT_VERSION,
    id: stringValue(source.id, `${sourceLabel}.id`),
    name: stringValue(source.name, `${sourceLabel}.name`),
    revision: positiveInteger(source.revision, `${sourceLabel}.revision`),
    description: stringValue(source.description, `${sourceLabel}.description`),
    citations: arrayValue(source.citations ?? [], `${sourceLabel}.citations`).map(
      (citation, index) => parseCitation(citation, `${sourceLabel}.citations[${index}]`)
    ),
    partTypes: arrayValue(source.partTypes, `${sourceLabel}.partTypes`).map((partType, index) =>
      parsePartType(partType, `${sourceLabel}.partTypes[${index}]`)
    ),
    members: arrayValue(source.members, `${sourceLabel}.members`).map((member, index) =>
      parseMember(member, `${sourceLabel}.members[${index}]`)
    ),
    recipes: arrayValue(source.recipes, `${sourceLabel}.recipes`).map((recipe, index) =>
      parseRecipe(recipe, `${sourceLabel}.recipes[${index}]`)
    ),
    assemblySchemas: arrayValue(
      source.assemblySchemas ?? (formatVersion === 2 ? [] : undefined),
      `${sourceLabel}.assemblySchemas`
    ).map((value, index) => parseAssemblySchema(value, `${sourceLabel}.assemblySchemas[${index}]`)),
  };
  validateDefinition(definition, sourceLabel);
  const migrated = formatVersion === 2 ? migrateMocloKitV2(definition) : definition;
  validateDefinition(migrated, sourceLabel);
  return migrated;
}

export function mocloAssemblySchemaOptions(definition: MocloKitDefinition): Array<{
  schema: GoldenGateAssemblySchema;
  topology: 'linear' | 'circular';
}> {
  return definition.assemblySchemas.map((template) => ({
    topology: template.topology,
    schema: {
      id: `${definition.id}:${template.id}`,
      name: template.name,
      revision: definition.revision,
      origin: {
        type: 'kit',
        kitId: definition.id,
        kitName: definition.name,
        schemaId: template.id,
      },
      enzyme: template.enzyme,
      slots: template.slots,
    },
  }));
}

export function schemaForMocloStage(
  definition: MocloKitDefinition,
  stage: MocloKitStageDefinition
): GoldenGateAssemblySchema {
  const recipe = definition.recipes.find((candidate) => candidate.stages.includes(stage));
  if (!recipe) throw new Error(`Stage “${stage.id}” does not belong to kit “${definition.id}”.`);
  return {
    id: `${definition.id}:${recipe.id}:${stage.id}`,
    name: stage.outputRole.label,
    revision: definition.revision,
    origin: {
      type: 'kit',
      kitId: definition.id,
      kitName: definition.name,
      schemaId: `${recipe.id}:${stage.id}`,
    },
    enzyme: stage.enzyme,
    slots: stage.slots.map(({ input: _input, ...slot }) => slot),
  };
}

export function findMocloKitStage(
  definition: MocloKitDefinition,
  recipeId: string,
  stageId: string
): MocloKitStageDefinition {
  const recipe = definition.recipes.find((candidate) => candidate.id === recipeId);
  if (!recipe) throw new Error(`MoClo kit “${definition.id}” has no recipe “${recipeId}”.`);
  const stage = recipe.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error(`MoClo recipe “${recipeId}” has no stage “${stageId}”.`);
  return stage;
}

export function createMocloFactoryStageSelection(
  definition: MocloKitDefinition,
  recipe: MocloKitRecipe,
  stage: MocloKitStageDefinition
): MocloFactoryStageSelection {
  if (!definition.recipes.includes(recipe) || !recipe.stages.includes(stage)) {
    throw new Error('MoClo factory selection must reference one recipe stage from its kit.');
  }
  return {
    kitId: definition.id,
    kitRevision: definition.revision,
    recipeId: recipe.id,
    stageId: stage.id,
    schema: schemaForMocloStage(definition, stage),
    stageInputs: stage.slots.flatMap((slot) =>
      slot.input.kind === 'stage-output'
        ? [{ slotId: slot.id, sourceStageId: slot.input.stageId }]
        : []
    ),
  };
}

function kitDirectoryPath(workspaceRoot: string): string {
  return `${workspaceRoot.replace(/[\\/]+$/, '')}/${MOCLO_KIT_DIRECTORY}`;
}

export async function loadMocloKitDefinitions(
  workspaceRoot: string | null,
  fs: MocloKitFileSystem = platform().fs
): Promise<MocloKitDefinition[]> {
  const inventory = await loadMocloKitDefinitionInventory(workspaceRoot, fs);
  if (inventory.issues.length > 0) {
    throw new Error(inventory.issues.map((issue) => issue.message).join('\n'));
  }
  return inventory.definitions;
}

export async function loadMocloKitDefinitionInventory(
  workspaceRoot: string | null,
  fs: MocloKitFileSystem = platform().fs
): Promise<MocloKitDefinitionInventory> {
  if (!workspaceRoot) return { definitions: [], issues: [] };
  const directory = kitDirectoryPath(workspaceRoot);
  if (!(await fs.exists(directory))) return { definitions: [], issues: [] };
  const entries = (await fs.readDir(directory))
    .filter((entry) => entry.isFile && entry.name.toLowerCase().endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const loaded = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      let kitId: string | undefined;
      try {
        const text = await fs.readTextFile(path);
        let identity: Record<string, unknown> = {};
        try {
          identity = record(JSON.parse(text), path);
        } catch {}
        if (typeof identity.id === 'string') kitId = identity.id.trim();
        return {
          source: path,
          definition: parseMocloKitDefinition(text, path),
          issue: null,
          kitId,
        };
      } catch (error) {
        return {
          source: path,
          definition: null,
          issue: error instanceof Error ? error.message : String(error),
          kitId,
        };
      }
    })
  );
  const idCounts = new Map<string, number>();
  for (const item of loaded) {
    if (item.definition) {
      idCounts.set(item.definition.id, (idCounts.get(item.definition.id) ?? 0) + 1);
    }
  }

  const definitions = loaded.flatMap((item) =>
    item.definition && idCounts.get(item.definition.id) === 1 ? [item.definition] : []
  );
  const issues = loaded.flatMap((item): MocloKitDefinitionLoadIssue[] => {
    if (item.issue)
      return [
        { source: item.source, message: item.issue, ...(item.kitId ? { kitId: item.kitId } : {}) },
      ];
    if (item.definition && (idCounts.get(item.definition.id) ?? 0) > 1) {
      return [
        {
          source: item.source,
          kitId: item.definition.id,
          message: `${directory} contains duplicate kit id “${item.definition.id}”; every conflicting definition was ignored.`,
        },
      ];
    }
    return [];
  });
  return { definitions, issues };
}

export function resolveMocloKitMembership(
  definitions: readonly MocloKitDefinition[],
  reference: MocloKitReferenceIdentity
): MocloKitMembership | null {
  return resolveMocloKitMemberships(definitions, reference)[0] ?? null;
}

export function resolveMocloKitMemberships(
  definitions: readonly MocloKitDefinition[],
  reference: MocloKitReferenceIdentity
): MocloKitMembership[] {
  const memberships: MocloKitMembership[] = [];
  for (const definition of definitions) {
    const member = definition.members.find(
      (candidate) => candidate.sequencePackageId === reference.packageId
    );
    if (!member) continue;
    const partType =
      member.partTypeId === undefined
        ? null
        : (definition.partTypes.find((candidate) => candidate.id === member.partTypeId) ?? null);
    if (member.partTypeId !== undefined && !partType) continue;
    memberships.push({
      kit: { id: definition.id, name: definition.name },
      definition,
      member,
      partType,
      roleEvidence:
        partType?.roleTerms.map((role) => ({
          ...role,
          source: `${definition.name} definition · ${partType.label}`,
        })) ?? [],
    });
  }
  return memberships;
}
