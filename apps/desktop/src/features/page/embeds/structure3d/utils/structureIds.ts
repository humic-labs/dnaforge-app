import type { ChainSequence } from '../types';
import type { PluginContext } from 'molstar/lib/mol-plugin/context';
import type { Structure } from 'molstar/lib/mol-model/structure';

export type NativeStructureSourceScope = {
  structureRef?: string;
  sourceLabel?: string;
  isPrimarySource?: boolean;
};

export function nativeStructureSources(plugin: unknown) {
  const context = plugin as PluginContext | null | undefined;
  const entries = context?.managers?.structure?.hierarchy?.current?.structures ?? [];
  const transforms = context?.state?.data?.tree?.transforms;
  const sources = entries.flatMap((entry, index) => {
    const cell = entry.transform?.cell ?? entry.cell;
    const structure = cell.obj?.data as Structure | undefined;
    if (!structure) return [];
    let cursor: string | undefined = cell.transform?.ref;
    let structureRef: string | undefined;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const transform: { tags?: readonly string[]; parent?: string } | undefined =
        transforms?.get(cursor);
      const tag = transform?.tags?.find((value) => value.startsWith('mvs-ref:'));
      if (tag) {
        structureRef = tag.slice('mvs-ref:'.length);
        break;
      }
      cursor = transform?.parent;
    }
    if (!structureRef && entries.length > 1)
      structureRef = `native:${cell.transform?.ref ?? structure.units?.[0]?.model.id ?? index}`;
    const entryLabels = [
      ...new Set((structure.units ?? []).map((unit) => unit.model.entryId).filter(Boolean)),
    ];
    return [{ entry, structure, structureRef, sourceLabel: entryLabels.join(', ') || undefined }];
  });
  const canonicalPrimary = sources.findIndex(
    (source) => source.structureRef === 'dnaforge:comparison:1'
  );
  const primaryIndex = canonicalPrimary < 0 ? 0 : canonicalPrimary;
  return sources.map((source, index) => ({
    ...source,
    ...(source.structureRef ? { isPrimarySource: index === primaryIndex } : {}),
  }));
}

export function nativeStructureSourceScope(
  plugin: unknown,
  structure: Structure
): NativeStructureSourceScope {
  const sources = nativeStructureSources(plugin);
  let current: Structure | undefined = structure;
  let source: (typeof sources)[number] | undefined;
  while (current) {
    source = sources.find((candidate) => candidate.structure === current);
    if (source) break;
    current = current.parent;
  }
  if (!source) {
    const matches = sources.filter((candidate) =>
      structure.units.every((unit) =>
        candidate.structure.units.some(
          (parent) =>
            parent.model.id === unit.model.id &&
            parent.id === unit.id &&
            parent.conformation.operator === unit.conformation.operator
        )
      )
    );
    if (matches.length === 1) source = matches[0];
  }
  if (!source) return {};
  return {
    ...(source.structureRef ? { structureRef: source.structureRef } : {}),
    ...(source.sourceLabel ? { sourceLabel: source.sourceLabel } : {}),
    ...(source.isPrimarySource !== undefined ? { isPrimarySource: source.isPrimarySource } : {}),
  };
}

declare const structureIdBrand: unique symbol;

export type StructureBrandedId<Name extends string> = string & {
  readonly [structureIdBrand]: Name;
};

export type BiologicalSourceId = StructureBrandedId<'BiologicalSourceId'>;
export type StructureMemberId = StructureBrandedId<'StructureMemberId'>;
export type ChainInstanceId = StructureBrandedId<'ChainInstanceId'>;
export type StructureChainGroupId = StructureBrandedId<'StructureChainGroupId'>;
export type VisualLayerId = StructureBrandedId<'VisualLayerId'>;
export type VisualLayerStableKey = StructureBrandedId<'VisualLayerStableKey'>;
export type MolstarComponentTag = StructureBrandedId<'MolstarComponentTag'>;
export type MolstarRepresentationTag = StructureBrandedId<'MolstarRepresentationTag'>;
export type StructureByteCacheKey = StructureBrandedId<'StructureByteCacheKey'>;

export function biologicalSourceId(value: string): BiologicalSourceId {
  return brandNonEmpty(value, 'BiologicalSourceId');
}

export function structureMemberId(value: string): StructureMemberId {
  return brandNonEmpty(value, 'StructureMemberId');
}

export function chainInstanceId(value: string): ChainInstanceId {
  return brandNonEmpty(value, 'ChainInstanceId');
}

export function structureChainGroupId(value: string): StructureChainGroupId {
  return brandNonEmpty(value, 'StructureChainGroupId');
}

export function visualLayerId(value: string): VisualLayerId {
  return brandNonEmpty(value, 'VisualLayerId');
}

export function visualLayerStableKey(value: string): VisualLayerStableKey {
  return brandNonEmpty(value, 'VisualLayerStableKey');
}

export function molstarComponentTag(value: string): MolstarComponentTag {
  return brandNonEmpty(value, 'MolstarComponentTag');
}

export function molstarRepresentationTag(value: string): MolstarRepresentationTag {
  return brandNonEmpty(value, 'MolstarRepresentationTag');
}

export function structureByteCacheKey(value: string): StructureByteCacheKey {
  return brandNonEmpty(value, 'StructureByteCacheKey');
}

export function chainInstanceIdForSequenceChain(chain: ChainSequence): ChainInstanceId {
  return chainInstanceIdForIdentity(chain);
}

export function chainInstanceIdForIdentity(
  chain: Pick<
    ChainSequence,
    | 'authAsymId'
    | 'labelAsymId'
    | 'entityId'
    | 'operator'
    | 'chainId'
    | 'instanceId'
    | 'structureRef'
    | 'isPrimarySource'
  >
): ChainInstanceId {
  const distinctInstance =
    chain.instanceId && chain.instanceId.replace(/-/g, '_') !== chain.operator?.replace(/-/g, '_')
      ? chain.instanceId
      : undefined;
  return chainInstanceId(
    stableStructureIdToken(
      [
        chain.isPrimarySource === false ? chain.structureRef : undefined,
        chain.authAsymId,
        chain.labelAsymId,
        chain.entityId,
        chain.operator,
        chain.chainId,
        distinctInstance,
      ]
        .filter(Boolean)
        .join(':')
    )
  );
}

export function stableStructureIdToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function brandNonEmpty<Name extends string>(value: string, label: Name): StructureBrandedId<Name> {
  if (!value.trim()) throw new Error(`${label} cannot be empty`);
  return value as StructureBrandedId<Name>;
}
