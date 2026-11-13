import { withUserMessage } from '@waypoint/user-messages';
import { platform } from '../../platform';
import { searchCatalogSequencePackagesByIds } from '../../db/catalog-reference-search';
import { pathIsAtOrUnder } from '../../shared/path-boundary';
import { resolveSequenceDocument } from '../sequence/public/sequence-document-repository';
import type {
  WorkspaceTextFileAtomicWriteInput,
  WorkspaceTextFileAtomicWriteResult,
} from '../../shared/workspace-file-atomic';
import type { GoldenGateAssemblySchema } from './golden-gate-schema';
import {
  loadMocloKitDefinitionInventory,
  bundledMocloKitDefinitions,
  MOCLO_KIT_DIRECTORY,
  MOCLO_KIT_FORMAT_VERSION,
  MOCLO_KIT_SCHEMA,
  parseMocloKitDefinition,
  type MocloKitDefinition,
  type MocloKitDefinitionInventory,
  type MocloKitFileSystem,
  type MocloKitCitation,
  type MocloKitPartType,
  type MocloKitAssemblySchema,
} from './moclo-kit-definition';

const builtins = bundledMocloKitDefinitions();
const listeners = new Set<(projectRoot: string) => void>();

export function subscribeMocloSchemaCatalog(listener: (projectRoot: string) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function loadMocloSchemaCatalog(
  projectRoot: string | null,
  fs: MocloKitFileSystem = platform().fs
): Promise<MocloKitDefinitionInventory> {
  if (!projectRoot) return { definitions: [], issues: [] };
  const inventory = await loadMocloKitDefinitionInventory(projectRoot, fs);
  const conflictedIds = new Set(
    inventory.issues.flatMap((issue) => (issue.kitId ? [issue.kitId] : []))
  );
  const definitions = [...inventory.definitions];
  for (const builtin of builtins) {
    if (!conflictedIds.has(builtin.id) && !definitions.some((kit) => kit.id === builtin.id))
      definitions.push(structuredClone(builtin));
  }
  return { definitions, issues: inventory.issues };
}

export async function loadMocloSchemaDefinitions(
  projectRoot: string
): Promise<MocloKitDefinition[]> {
  const catalog = await loadMocloSchemaCatalog(projectRoot);
  if (catalog.issues.length)
    throw new Error(catalog.issues.map((issue) => issue.message).join('\n'));
  return catalog.definitions;
}

interface SchemaFileSystem extends MocloKitFileSystem {
  sha256File(path: string): Promise<string>;
  writeWorkspaceTextFileAtomic(
    input: WorkspaceTextFileAtomicWriteInput
  ): Promise<WorkspaceTextFileAtomicWriteResult>;
}

export interface SaveMocloSchemaInput {
  projectRoot: string;
  kitId: string;
  kitName?: string;
  expectedKitRevision: number;
  templateId: string;
  name: string;
  description: string;
  schema: GoldenGateAssemblySchema;
  topology: 'linear' | 'circular';
}

export async function saveMocloSchema(
  input: SaveMocloSchemaInput,
  fs: SchemaFileSystem = platform().fs,
  assertPreviewCurrent: () => void = () => {}
) {
  if (!input.templateId.trim()) throw new Error('Schema id is required.');
  const saved = await updateMocloKitDefinition(
    { ...input, name: input.kitName },
    (base) => {
      const template = {
        id: input.templateId,
        name: input.name,
        description: input.description,
        enzyme: input.schema.enzyme,
        topology: input.topology,
        slots: structuredClone(input.schema.slots),
      };
      return {
        ...base,
        assemblySchemas: [
          ...(base.assemblySchemas ?? []).filter((item) => item.id !== template.id),
          template,
        ],
      };
    },
    fs,
    assertPreviewCurrent
  );
  return { schemaId: `${saved.kitId}:${input.templateId}`, ...saved };
}

export interface SaveMocloKitInput {
  projectRoot: string;
  kitId: string;
  expectedKitRevision: number;
  name?: string;
  description?: string;
  citations?: MocloKitCitation[];
  partTypes?: MocloKitPartType[];
  members?: Array<{ sequencePackageId: string; partTypeId?: string | null }>;
  assemblySchemas?: MocloKitAssemblySchema[];
  removeMemberPackageIds?: string[];
  removePartTypeIds?: string[];
  removeSchemaIds?: string[];
}

function removeKitItems<T>(
  items: readonly T[],
  removals: readonly string[] = [],
  updates: readonly string[],
  identify: (item: T) => string,
  noun: string
): T[] {
  const removed = new Set<string>();
  for (const id of removals) {
    if (removed.has(id)) throw new Error(`Duplicate ${noun} removal: ${id}.`);
    if (!items.some((item) => identify(item) === id)) throw new Error(`Unknown ${noun}: ${id}.`);
    if (updates.includes(id)) throw new Error(`Cannot update and remove the same ${noun}: ${id}.`);
    removed.add(id);
  }
  return items.filter((item) => !removed.has(identify(item)));
}

type ResolveKitMembers = (
  projectRoot: string,
  packageIds: readonly string[]
) => Promise<Array<{ packageId: string; name: string }>>;

export async function saveMocloKit(
  input: SaveMocloKitInput,
  fs: SchemaFileSystem = platform().fs,
  resolveMembers: ResolveKitMembers = resolveKitMembers
) {
  return updateMocloKitDefinition(
    input,
    async (base) => {
      const members = removeKitItems(
        base.members,
        input.removeMemberPackageIds,
        (input.members ?? []).map((item) => item.sequencePackageId),
        (item) => item.sequencePackageId,
        'member'
      );
      const seen = new Set<string>();
      for (const update of input.members ?? []) {
        if (seen.has(update.sequencePackageId)) throw new Error('Duplicate member in kit update.');
        seen.add(update.sequencePackageId);
        const index = members.findIndex(
          (member) => member.sequencePackageId === update.sequencePackageId
        );
        const existing = index < 0 ? undefined : members[index];
        const member = {
          ...(existing ?? { id: update.sequencePackageId, name: update.sequencePackageId }),
          sequencePackageId: update.sequencePackageId,
          partTypeId:
            update.partTypeId === null ? undefined : (update.partTypeId ?? existing?.partTypeId),
        };
        if (index < 0) members.push(member);
        else members[index] = member;
      }
      const partTypes = removeKitItems(
        base.partTypes,
        input.removePartTypeIds,
        (input.partTypes ?? []).map((item) => item.id),
        (item) => item.id,
        'part type'
      );
      const seenTypes = new Set<string>();
      for (const partType of input.partTypes ?? []) {
        if (seenTypes.has(partType.id)) throw new Error('Duplicate part type in kit update.');
        seenTypes.add(partType.id);
        const index = partTypes.findIndex((existing) => existing.id === partType.id);
        if (index < 0) partTypes.push(partType);
        else partTypes[index] = partType;
      }
      const schemas = removeKitItems(
        base.assemblySchemas,
        input.removeSchemaIds,
        (input.assemblySchemas ?? []).map((item) => item.id),
        (item) => item.id,
        'schema'
      );
      const definition = parseMocloKitDefinition(
        JSON.stringify({
          ...base,
          name: input.name ?? base.name,
          description: input.description ?? base.description,
          citations: input.citations ?? base.citations,
          revision: input.expectedKitRevision + 1,
          partTypes,
          members,
          assemblySchemas: [
            ...schemas.filter(
              (existing) => !input.assemblySchemas?.some((update) => update.id === existing.id)
            ),
            ...(input.assemblySchemas ?? []),
          ],
        })
      );
      const resolved = await resolveMembers(
        input.projectRoot,
        definition.members.map((member) => member.sequencePackageId)
      );
      definition.members = definition.members.map((member) => {
        const matches = resolved.filter((item) => item.packageId === member.sequencePackageId);
        if (matches.length !== 1)
          throw new Error(
            `Kit member ${member.sequencePackageId} is unavailable or ambiguous in this project. Import it first.`
          );
        return { ...member, name: matches[0].name };
      });
      return definition;
    },
    fs
  );
}

async function resolveKitMembers(projectRoot: string, packageIds: readonly string[]) {
  const references = await searchCatalogSequencePackagesByIds({
    workspaceRoot: projectRoot,
    sequencePackageIds: packageIds,
  });
  const result: Array<{ packageId: string; name: string }> = [];
  for (const reference of references) {
    const ref = reference.sequenceDocument;
    if (ref?.kind !== 'managed-sequence' || !pathIsAtOrUnder(ref.packageRoot, projectRoot))
      continue;
    const document = await resolveSequenceDocument(ref);
    if (
      document.documentId !== ref.packageId ||
      !document.name ||
      !(await platform().fs.exists(document.sourcePath))
    ) {
      throw new Error(
        `Kit member ${ref.packageId} is not a readable managed sequence in this project.`
      );
    }
    result.push({ packageId: ref.packageId, name: document.name });
  }
  return result;
}

async function updateMocloKitDefinition(
  input: Pick<
    SaveMocloKitInput,
    'projectRoot' | 'kitId' | 'expectedKitRevision' | 'name' | 'description'
  >,
  update: (base: MocloKitDefinition) => MocloKitDefinition | Promise<MocloKitDefinition>,
  fs: SchemaFileSystem,
  assertCurrent: () => void = () => {}
) {
  if (!input.projectRoot) throw new Error('A kit must belong to a project.');
  if (!/^[a-z0-9][a-z0-9_-]{0,119}$/i.test(input.kitId))
    throw new Error('Kit id must contain only letters, numbers, hyphens or underscores.');
  const catalog = await loadMocloSchemaCatalog(input.projectRoot, fs);
  if (catalog.issues.length)
    throw new Error(catalog.issues.map((issue) => issue.message).join('\n'));
  const current = catalog.definitions.find((kit) => kit.id === input.kitId);
  if ((current?.revision ?? 0) !== input.expectedKitRevision)
    throw withUserMessage(
      new Error('The kit changed. Read the current kit revision before saving.'),
      'validation.compatible.25'
    );
  if (!current && (!input.name?.trim() || !input.description?.trim()))
    throw new Error('A new kit needs a name and description.');
  const directory = `${input.projectRoot.replace(/[\\/]+$/, '')}/${MOCLO_KIT_DIRECTORY}`;
  let path = `${directory}/${input.kitId}.json`;
  let original: MocloKitDefinition | undefined;
  let expectedContentHash: string | undefined;
  if (await fs.exists(directory)) {
    for (const entry of await fs.readDir(directory)) {
      if (!entry.isFile || !entry.name.toLowerCase().endsWith('.json')) continue;
      const candidatePath = `${directory}/${entry.name}`;
      const candidate = parseMocloKitDefinition(
        await fs.readTextFile(candidatePath),
        candidatePath
      );
      if (candidate.id !== input.kitId) continue;
      path = candidatePath;
      expectedContentHash = (await fs.sha256File(path)).replace(/^sha256:/, '');
      original = parseMocloKitDefinition(await fs.readTextFile(path), path);
      if (original.id !== input.kitId || original.revision !== input.expectedKitRevision)
        throw new Error('The kit changed while saving. Read it again.');
      break;
    }
  }
  const base: MocloKitDefinition = original ??
    current ?? {
      schema: MOCLO_KIT_SCHEMA,
      formatVersion: MOCLO_KIT_FORMAT_VERSION,
      id: input.kitId,
      name: input.name!,
      revision: 0,
      description: input.description!,
      citations: [],
      partTypes: [],
      members: [],
      recipes: [],
      assemblySchemas: [],
    };
  const definition = parseMocloKitDefinition(
    JSON.stringify({
      ...(await update(structuredClone(base))),
      revision: (current?.revision ?? 0) + 1,
    })
  );
  assertCurrent();
  const result = await fs.writeWorkspaceTextFileAtomic({
    workspaceRoot: input.projectRoot,
    path,
    content: `${JSON.stringify(definition, null, 2)}\n`,
    mode: original ? 'replace' : 'create',
    ...(expectedContentHash ? { expectedContentHash } : {}),
    artifactNoun: 'MoClo kit',
  });
  for (const listener of listeners) queueMicrotask(() => listener(input.projectRoot));
  return {
    kitId: definition.id,
    kitRevision: definition.revision,
    ...result,
  };
}
