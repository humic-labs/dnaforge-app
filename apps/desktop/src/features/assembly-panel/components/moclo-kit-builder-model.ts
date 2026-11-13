import {
  userMessage,
  userMessageWithValues,
  userMessageValue,
  type UserMessage,
} from '@waypoint/user-messages';
import { ENZYME_SPECS, GOLDEN_GATE_ENZYME_NAMES } from '../../design/public/types';
import type { GoldenGateEnzyme } from '../../design/public/types';
import type {
  MocloKitAssemblySchema,
  MocloKitCitation,
  MocloKitDefinition,
} from '../../design/public/moclo-kit-definition';
import { validateGoldenGateSchema } from '../../design/public/golden-gate-schema';

export interface KitBuilderPosition {
  id: string;
  label: string;
  outgoingOverhang: string;
  role: string;
}

export interface KitBuilderLayout {
  id: string;
  name: string;
  description: string;
  enzyme: GoldenGateEnzyme;
  topology: 'linear' | 'circular';
  positions: KitBuilderPosition[];
}

export interface KitBuilderMember {
  sequencePackageId: string;
  name: string;
}

export interface KitBuilderState {
  name: string;
  description: string;
  citations: MocloKitCitation[];
  members: KitBuilderMember[];
  layouts: KitBuilderLayout[];
  activeLayoutId: string | null;
}

export const KIT_BUILDER_ENZYMES = GOLDEN_GATE_ENZYME_NAMES;

export const DEFAULT_LAYOUT_NAME = 'New layout';

export function defaultPositionLabel(index: number): string {
  return `Position ${index + 1}`;
}

export function kitIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/g, '');
  return slug;
}

export function uniqueId(base: string, taken: readonly string[]): string {
  const seed = base || 'item';
  if (!taken.includes(seed)) return seed;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${seed}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export function emptyPosition(taken: readonly string[], index: number): KitBuilderPosition {
  return {
    id: uniqueId(`position-${index + 1}`, taken),
    label: defaultPositionLabel(index),
    outgoingOverhang: '',
    role: '',
  };
}

export function emptyLayout(taken: readonly string[]): KitBuilderLayout {
  const id = uniqueId('layout', taken);
  const positions: KitBuilderPosition[] = [];
  for (let index = 0; index < 3; index += 1) {
    positions.push(
      emptyPosition(
        positions.map((position) => position.id),
        index
      )
    );
  }
  return {
    id,
    name: DEFAULT_LAYOUT_NAME,
    description: '',
    enzyme: 'BsaI',
    topology: 'circular',
    positions,
  };
}

export function stateFromDefinition(definition: MocloKitDefinition | null): KitBuilderState {
  if (!definition) {
    const layout = emptyLayout([]);
    return {
      name: '',
      description: '',
      citations: [],
      members: [],
      layouts: [layout],
      activeLayoutId: layout.id,
    };
  }
  const layouts = definition.assemblySchemas.map((schema) => layoutFromSchema(schema));
  return {
    name: definition.name,
    description: definition.description,
    citations: definition.citations,
    members: definition.members.map((member) => ({
      sequencePackageId: member.sequencePackageId,
      name: member.name,
    })),
    layouts,
    activeLayoutId: layouts[0]?.id ?? null,
  };
}

export function layoutFromSchema(schema: MocloKitAssemblySchema): KitBuilderLayout {
  return {
    id: schema.id,
    name: schema.name,
    description: schema.description,
    enzyme: schema.enzyme,
    topology: schema.topology,
    positions: schema.slots.map((slot) => ({
      id: slot.id,
      label: slot.label,
      outgoingOverhang: slot.outgoingOverhang ?? '',
      role: slot.preferredRoles[0]?.label ?? '',
    })),
  };
}

export function schemaFromLayout(layout: KitBuilderLayout): MocloKitAssemblySchema {
  return {
    id: layout.id,
    name: layout.name.trim(),
    description: layout.description.trim() || layout.name.trim(),
    enzyme: layout.enzyme,
    topology: layout.topology,
    slots: layout.positions.map((position) => ({
      id: position.id,
      label: position.label.trim(),
      outgoingOverhang: position.outgoingOverhang.trim()
        ? position.outgoingOverhang.trim().toUpperCase()
        : null,
      preferredRoles: position.role.trim() ? [{ label: position.role.trim() }] : [],
    })),
  };
}

export interface KitBuilderIssue {
  layoutId?: string;
  message: UserMessage;
}

export function validateKitBuilderState(state: KitBuilderState): KitBuilderIssue[] {
  const issues: KitBuilderIssue[] = [];
  if (!state.name.trim()) issues.push({ message: userMessage('guidance.the-kit-needs-a-name') });
  if (!state.description.trim()) issues.push({ message: userMessage('assembly.kitDescription') });
  if (state.name.trim() && !kitIdFromName(state.name)) {
    issues.push({ message: userMessage('assembly.kitNameCharacters') });
  }
  const layoutIds = new Set<string>();
  for (const layout of state.layouts) {
    if (layoutIds.has(layout.id)) {
      issues.push({ layoutId: layout.id, message: userMessage('assembly.layoutDuplicate') });
    }
    layoutIds.add(layout.id);
    if (!layout.name.trim()) {
      issues.push({ layoutId: layout.id, message: userMessage('assembly.layoutName') });
      continue;
    }
    const expected = ENZYME_SPECS[layout.enzyme].overhangLength;
    for (const position of layout.positions) {
      if (!position.outgoingOverhang.trim()) {
        issues.push({
          layoutId: layout.id,
          message: userMessageWithValues('assembly.junctionMissing', {
            position: userMessageValue(position.label || 'Unnamed position'),
            enzyme: userMessageValue(layout.enzyme),
            length: userMessageValue(expected),
          }),
        });
      }
    }
    const schema = schemaFromLayout(layout);
    const validation = validateGoldenGateSchema(
      { ...schema, revision: 1, origin: { type: 'custom' } },
      layout.topology
    );
    if (!validation.ok) {
      for (const issue of validation.issues) {
        issues.push({ layoutId: layout.id, message: issue.message });
      }
    }
  }
  return issues;
}

export interface KitSavePayload {
  kitId: string;
  expectedKitRevision: number;
  name: string;
  description: string;
  citations?: MocloKitCitation[];
  members?: Array<{ sequencePackageId: string }>;
  assemblySchemas: MocloKitAssemblySchema[];
  removeSchemaIds?: string[];
  removeMemberPackageIds?: string[];
}

export function savePayload(
  state: KitBuilderState,
  existing: MocloKitDefinition | null
): KitSavePayload {
  const assemblySchemas = state.layouts.map((layout) => schemaFromLayout(layout));
  const keptIds = new Set(assemblySchemas.map((schema) => schema.id));
  const removeSchemaIds = (existing?.assemblySchemas ?? [])
    .map((schema) => schema.id)
    .filter((id) => !keptIds.has(id));
  const keptMembers = new Set(state.members.map((member) => member.sequencePackageId));
  const removeMemberPackageIds = (existing?.members ?? [])
    .map((member) => member.sequencePackageId)
    .filter((id) => !keptMembers.has(id));
  const existingMembers = new Set(
    (existing?.members ?? []).map((member) => member.sequencePackageId)
  );
  const addedMembers = state.members
    .filter((member) => !existingMembers.has(member.sequencePackageId))
    .map((member) => ({ sequencePackageId: member.sequencePackageId }));
  return {
    kitId: existing?.id ?? kitIdFromName(state.name),
    expectedKitRevision: existing?.revision ?? 0,
    name: state.name.trim(),
    description: state.description.trim(),
    ...(state.citations.length ? { citations: state.citations } : {}),
    ...(addedMembers.length ? { members: addedMembers } : {}),
    assemblySchemas,
    ...(removeSchemaIds.length ? { removeSchemaIds } : {}),
    ...(removeMemberPackageIds.length ? { removeMemberPackageIds } : {}),
  };
}

const GENERIC_KIT_WORDS = new Set(['moclo', 'kit', 'toolkit', 'the', 'a', 'v1', 'v2', 'assembly']);

function kitNameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token && !GENERIC_KIT_WORDS.has(token))
  );
}

export interface KitDuplicateWarning {
  kind: 'same-id' | 'similar-name';
  existingKitId: string;
  existingKitName: string;
}

export function findKitDuplicate(
  name: string,
  existingKits: readonly { id: string; name: string }[]
): KitDuplicateWarning | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const id = kitIdFromName(trimmed);
  const byId = existingKits.find((kit) => kit.id === id);
  if (byId) {
    return { kind: 'same-id', existingKitId: byId.id, existingKitName: byId.name };
  }
  const tokens = kitNameTokens(trimmed);
  if (tokens.size === 0) return null;
  for (const kit of existingKits) {
    const other = kitNameTokens(kit.name);
    if (other.size === 0) continue;
    const smaller = tokens.size <= other.size ? tokens : other;
    const larger = smaller === tokens ? other : tokens;
    if ([...smaller].every((token) => larger.has(token))) {
      return { kind: 'similar-name', existingKitId: kit.id, existingKitName: kit.name };
    }
  }
  return null;
}
