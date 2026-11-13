import { computeChecksum } from '@waypoint/sequence-utils';
import type {
  AcceptedAssemblyHistoricalComponentSource,
  AcceptedAssemblySidecarPayload,
} from './accepted-types';
import { canonicalizeAcceptedAssemblyValue } from './accepted-canonical';
import {
  acceptedAssemblyVersionFromSidecar,
  sequenceDesignFromAcceptedAssemblyVersion,
} from './accepted-reopen';
import type {
  DesignPrimerPair,
  DesignRegion,
  DesignSpacer,
  GoldenGateJunction,
  HomologyRegion,
  SequenceDesign,
} from '../design/public/types';
import { isPackageAssemblyWorkingCopyDesign } from '../design/public/package-working-copy-identity';

type ComponentKind = 'region' | 'spacer' | 'join' | 'primer-pair';

type SourcePin = {
  acceptedAssemblyVersionId: string;
  canonicalDraftChecksum: string;
  componentId: string;
  componentDigest: string;
};

export type HistoricalAssemblyComponent = SourcePin &
  (
    | { kind: 'region'; regionId: string }
    | { kind: 'spacer'; spacerId: string; leftRegionId: string; rightRegionId: string }
    | { kind: 'join'; method: 'gibson' | 'goldengate'; leftRegionId: string; rightRegionId: string }
    | { kind: 'primer-pair'; regionId: string; directions: readonly ['forward', 'reverse'] }
  );

export type HistoricalAssemblyTarget =
  | { kind: 'region'; regionId: string }
  | { kind: 'spacer' | 'join'; leftRegionId: string; rightRegionId: string }
  | { kind: 'primer-pair'; regionId: string };

type GapTarget = { kind: 'spacer' | 'join'; leftRegionId: string; rightRegionId: string };

export type HistoricalAssemblySelection = {
  source: HistoricalAssemblyComponent;
  target: HistoricalAssemblyTarget;
};

export type HistoricalAssemblyCatalog = {
  components: HistoricalAssemblyComponent[];
  unavailable: Array<{ acceptedAssemblyVersionId: string; reason: string }>;
};

type InternalComponent = {
  entry: HistoricalAssemblyComponent;
  value: unknown;
  record: AcceptedAssemblySidecarPayload;
  sourceIndex: number;
};

function key(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function pairAt(
  record: AcceptedAssemblySidecarPayload,
  junctionIndex: number
): { leftRegionId: string; rightRegionId: string } {
  const { regions, topology } = record.projectionInput;
  const count = regions.length - 1 + (topology === 'circular' ? 1 : 0);
  if (!Number.isSafeInteger(junctionIndex) || junctionIndex < 0 || junctionIndex >= count) {
    throw new Error(`Historical junction ${junctionIndex} has no unambiguous neighboring regions.`);
  }
  return {
    leftRegionId: regions[junctionIndex].id,
    rightRegionId: regions[(junctionIndex + 1) % regions.length].id,
  };
}

function gapIndex(
  design: Pick<SequenceDesign, 'regions' | 'topology'>,
  leftRegionId: string,
  rightRegionId: string
): number {
  if (leftRegionId === rightRegionId) {
    throw new Error('A historical gap cannot be mapped between duplicate region identities.');
  }
  const last = design.regions.length - 1;
  for (let index = 0; index <= last; index += 1) {
    if (index === last && design.topology !== 'circular') break;
    if (
      design.regions[index].id === leftRegionId &&
      design.regions[(index + 1) % design.regions.length].id === rightRegionId
    )
      return index;
  }
  throw new Error(`The target gap ${leftRegionId} → ${rightRegionId} no longer exists.`);
}

function assertUniqueRegions(record: AcceptedAssemblySidecarPayload): void {
  const ids = record.projectionInput.regions.map((region) => region.id);
  if (ids.length < 2 || new Set(ids).size !== ids.length) {
    throw new Error('Historical recipe has missing or duplicate region identities.');
  }
}

async function sourceEntry(
  record: AcceptedAssemblySidecarPayload,
  kind: ComponentKind,
  componentId: string,
  value: unknown,
  detail: Omit<HistoricalAssemblyComponent, keyof SourcePin | 'kind'>,
  sourceIndex: number
): Promise<InternalComponent> {
  const acceptedAssemblyVersionId = acceptedAssemblyVersionFromSidecar(record).id;
  const canonicalDraftChecksum = record.projectionInput.canonicalDraftChecksum;
  const componentDigest = await computeChecksum(
    canonicalizeAcceptedAssemblyValue({ kind, componentId, value })
  );
  return {
    entry: {
      kind,
      acceptedAssemblyVersionId,
      canonicalDraftChecksum,
      componentId,
      componentDigest,
      ...detail,
    } as HistoricalAssemblyComponent,
    value,
    record,
    sourceIndex,
  };
}

async function recordComponents(
  record: AcceptedAssemblySidecarPayload
): Promise<InternalComponent[]> {
  assertUniqueRegions(record);
  const { regions, spacers, homologyRegions, goldenGateJunctions, designPrimers, assemblyMethod } =
    record.projectionInput;
  const components: InternalComponent[] = [];
  const provenanceByRegion = new Map<string, unknown>();
  for (const snapshot of record.projectionInput.sourceProvenance) {
    if (provenanceByRegion.has(snapshot.regionId)) {
      throw new Error(`Historical region ${snapshot.regionId} has duplicate source provenance.`);
    }
    provenanceByRegion.set(snapshot.regionId, snapshot);
  }
  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index];
    components.push(
      await sourceEntry(
        record,
        'region',
        key(['region', region.id]),
        { region, provenance: provenanceByRegion.get(region.id) ?? null },
        { regionId: region.id },
        index
      )
    );
  }
  const seenSpacers = new Set<string>();
  for (const spacer of spacers) {
    const pair = pairAt(record, spacer.junctionIndex);
    const gap = key(['spacer', pair.leftRegionId, pair.rightRegionId]);
    if (seenSpacers.has(gap)) throw new Error(`Historical gap ${gap} has duplicate spacers.`);
    seenSpacers.add(gap);
    components.push(
      await sourceEntry(
        record,
        'spacer',
        key(['spacer', spacer.id, pair.leftRegionId, pair.rightRegionId]),
        spacer,
        { spacerId: spacer.id, ...pair },
        spacer.junctionIndex
      )
    );
  }
  const joins = assemblyMethod === 'goldengate' ? (goldenGateJunctions ?? []) : homologyRegions;
  const seenJoins = new Set<string>();
  for (const join of joins) {
    const pair = pairAt(record, join.junctionIndex);
    const joinId = key(['join', assemblyMethod, pair.leftRegionId, pair.rightRegionId]);
    if (seenJoins.has(joinId)) throw new Error(`Historical gap ${joinId} has duplicate joins.`);
    seenJoins.add(joinId);
    components.push(
      await sourceEntry(
        record,
        'join',
        joinId,
        join,
        { method: assemblyMethod, ...pair },
        join.junctionIndex
      )
    );
  }
  const seenPrimers = new Set<string>();
  for (const pair of designPrimers) {
    const index = pair.fragmentIndex;
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= regions.length ||
      pair.forward.direction !== 'forward' ||
      pair.reverse.direction !== 'reverse' ||
      pair.forward.fragmentIndex !== index ||
      pair.reverse.fragmentIndex !== index
    ) {
      throw new Error('Historical primer pair has ambiguous fragment or direction identity.');
    }
    const regionId = regions[index].id;
    if (seenPrimers.has(regionId)) {
      throw new Error(`Historical region ${regionId} has duplicate primer pairs.`);
    }
    seenPrimers.add(regionId);
    components.push(
      await sourceEntry(
        record,
        'primer-pair',
        key(['primer-pair', regionId, 'forward', 'reverse']),
        pair,
        { regionId, directions: ['forward', 'reverse'] },
        index
      )
    );
  }
  return components;
}

export async function catalogHistoricalAssemblyComponents(
  records: readonly AcceptedAssemblySidecarPayload[]
): Promise<HistoricalAssemblyCatalog> {
  const components: HistoricalAssemblyComponent[] = [];
  const unavailable: HistoricalAssemblyCatalog['unavailable'] = [];
  for (const record of records) {
    try {
      components.push(...(await recordComponents(record)).map((item) => item.entry));
    } catch (error) {
      unavailable.push({
        acceptedAssemblyVersionId: acceptedAssemblyVersionFromSidecar(record).id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { components, unavailable };
}

function targetId(target: HistoricalAssemblyTarget): string {
  switch (target.kind) {
    case 'region':
      return key(['region', target.regionId]);
    case 'spacer':
      return key(['spacer', target.leftRegionId, target.rightRegionId]);
    case 'join':
      return key(['join', target.leftRegionId, target.rightRegionId]);
    case 'primer-pair':
      return key(['primer-pair', target.regionId, 'forward', 'reverse']);
  }
}

function startOfRegion(design: Pick<SequenceDesign, 'regions' | 'spacers'>, index: number): number {
  let position = 0;
  for (let current = 0; current < index; current += 1) {
    position += design.regions[current].sequence.length;
    position +=
      design.spacers.find((spacer) => spacer.junctionIndex === current)?.sequence.length ?? 0;
  }
  return position;
}

function sameGapContext(
  source: AcceptedAssemblySidecarPayload,
  sourceIndex: number,
  target: SequenceDesign,
  targetIndex: number
): boolean {
  const sourceRegions = source.projectionInput.regions;
  const sourceSpacer = source.projectionInput.spacers.find(
    (item) => item.junctionIndex === sourceIndex
  );
  const targetSpacer = target.spacers.find((item) => item.junctionIndex === targetIndex);
  return (
    sourceRegions[sourceIndex].sequence === target.regions[targetIndex].sequence &&
    sourceRegions[(sourceIndex + 1) % sourceRegions.length].sequence ===
      target.regions[(targetIndex + 1) % target.regions.length].sequence &&
    (sourceSpacer?.sequence ?? '') === (targetSpacer?.sequence ?? '')
  );
}

function samePrimerContext(
  source: SequenceDesign,
  sourceIndex: number,
  target: SequenceDesign,
  targetIndex: number
): boolean {
  if (
    source.topology !== target.topology ||
    source.regions[sourceIndex].sequence !== target.regions[targetIndex].sequence
  )
    return false;
  const adjacent = (design: SequenceDesign, index: number, delta: -1 | 1) => {
    const neighbor = index + delta;
    if (design.topology === 'linear' && (neighbor < 0 || neighbor >= design.regions.length))
      return null;
    const wrapped = (neighbor + design.regions.length) % design.regions.length;
    const gap = delta === -1 ? wrapped : index;
    return {
      sequence: design.regions[wrapped].sequence,
      spacer: design.spacers.find((item) => item.junctionIndex === gap)?.sequence ?? '',
    };
  };
  return (
    canonicalizeAcceptedAssemblyValue(adjacent(source, sourceIndex, -1)) ===
      canonicalizeAcceptedAssemblyValue(adjacent(target, targetIndex, -1)) &&
    canonicalizeAcceptedAssemblyValue(adjacent(source, sourceIndex, 1)) ===
      canonicalizeAcceptedAssemblyValue(adjacent(target, targetIndex, 1))
  );
}

function sourceDesign(record: AcceptedAssemblySidecarPayload): SequenceDesign {
  return sequenceDesignFromAcceptedAssemblyVersion(acceptedAssemblyVersionFromSidecar(record), {
    designId: record.projectionInput.designId,
  });
}

async function stagedDigest(kind: ComponentKind, value: unknown): Promise<string> {
  if (kind === 'region') {
    const region = value as DesignRegion;
    value = {
      id: region.id,
      sourceSequenceId: region.sourceSequenceId,
      sourceSequenceName: region.sourceSequenceName,
      sourceStart: region.sourceStart,
      sourceEnd: region.sourceEnd,
      sequence: region.sequence,
      annotations: region.annotations,
      sourceType: region.sourceType,
      ggType: region.ggType,
      rdOverhangs: region.rdOverhangs,
      rdSourceEnzyme: region.rdSourceEnzyme,
      rdSourceEnzymeName: region.rdSourceEnzymeName,
      rdEnds: region.rdEnds,
      rdSiblingOverhangs: region.rdSiblingOverhangs,
    };
  }
  return computeChecksum(canonicalizeAcceptedAssemblyValue(value));
}

function remapJoin(
  join: HomologyRegion | GoldenGateJunction,
  targetIndex: number,
  delta: number
): HomologyRegion | GoldenGateJunction {
  if ('encoding' in join) {
    return {
      ...join,
      junctionIndex: targetIndex,
      junctionPosition: join.junctionPosition + delta,
      start: join.start + delta,
      end: join.end + delta,
      templateBasis: join.templateBasis
        ? {
            ...join.templateBasis,
            leftHomologyEnd: join.templateBasis.leftHomologyEnd + delta,
            rightHomologyStart: join.templateBasis.rightHomologyStart + delta,
          }
        : undefined,
    };
  }
  return {
    ...join,
    junctionIndex: targetIndex,
    junctionPosition: join.junctionPosition + delta,
    overhangStart: join.overhangStart + delta,
    overhangEnd: join.overhangEnd + delta,
  };
}

export async function composeHistoricalAssemblyComponents(
  design: SequenceDesign,
  records: readonly AcceptedAssemblySidecarPayload[],
  selections: readonly HistoricalAssemblySelection[]
): Promise<SequenceDesign> {
  if (!isPackageAssemblyWorkingCopyDesign(design)) {
    throw new Error('Historical components can be staged only in a package-owned assembly copy.');
  }
  if (selections.length === 0)
    throw new Error('Choose at least one historical assembly component.');
  if (new Set(design.regions.map((region) => region.id)).size !== design.regions.length) {
    throw new Error('Working copy has duplicate region identities.');
  }
  const internal = (await Promise.all(records.map(recordComponents))).flat();
  const byPin = new Map(
    internal.map((item) => [
      key([item.entry.acceptedAssemblyVersionId, item.entry.componentId]),
      item,
    ])
  );
  const resolved = selections.map((selection) => {
    if (selection.source.kind !== selection.target.kind) {
      throw new Error('Historical component and target kinds differ.');
    }
    const item = byPin.get(
      key([selection.source.acceptedAssemblyVersionId, selection.source.componentId])
    );
    if (
      !item ||
      item.entry.canonicalDraftChecksum !== selection.source.canonicalDraftChecksum ||
      item.entry.componentDigest !== selection.source.componentDigest ||
      item.entry.kind !== selection.source.kind
    ) {
      throw new Error(
        'Historical component pin or digest changed; refresh History before staging.'
      );
    }
    return { selection, item, targetComponentId: targetId(selection.target) };
  });
  const targetIds = resolved.map((item) => item.targetComponentId);
  if (new Set(targetIds).size !== targetIds.length) {
    throw new Error('Choose only one historical source for each target component.');
  }
  const structureChanged = resolved.some(
    ({ selection }) => selection.target.kind === 'region' || selection.target.kind === 'spacer'
  );
  if (
    structureChanged &&
    design.historicalComponentSources?.some(
      (old) =>
        (old.kind === 'join' || old.kind === 'primer-pair') &&
        !resolved.some((item) => item.targetComponentId === old.targetComponentId)
    )
  ) {
    throw new Error('Restage the previously chosen joins and primers with the changed structure.');
  }
  const next: SequenceDesign = {
    ...design,
    regions: [...design.regions],
    spacers: [...design.spacers],
    homologyRegions: structureChanged ? [] : [...design.homologyRegions],
    goldenGateJunctions: structureChanged ? [] : [...(design.goldenGateJunctions ?? [])],
    designPrimers: structureChanged ? [] : [...design.designPrimers],
    historicalComponentSources: structureChanged
      ? (design.historicalComponentSources ?? []).filter(
          (old) => old.kind === 'region' || old.kind === 'spacer'
        )
      : [...(design.historicalComponentSources ?? [])],
  };
  const receipts: AcceptedAssemblyHistoricalComponentSource[] = [];
  for (const { selection, item, targetComponentId } of resolved.filter(
    (resolvedItem) => resolvedItem.selection.target.kind === 'region'
  )) {
    const target = selection.target as Extract<HistoricalAssemblyTarget, { kind: 'region' }>;
    const index = next.regions.findIndex((region) => region.id === target.regionId);
    if (index < 0) throw new Error(`Target region ${target.regionId} no longer exists.`);
    const source = sourceDesign(item.record).regions[item.sourceIndex];
    const previous = next.regions[index];
    const staged: DesignRegion = {
      ...source,
      id: previous.id,
      schemaSlotId: previous.schemaSlotId,
      colorIndex: previous.colorIndex ?? source.colorIndex,
    };
    next.regions[index] = staged;
    const sourceRegionId = (item.entry as Extract<HistoricalAssemblyComponent, { kind: 'region' }>)
      .regionId;
    const pinned = item.record.projectionInput.sourceProvenance.find(
      (snapshot) => snapshot.regionId === sourceRegionId
    );
    receipts.push({
      kind: 'region',
      sourceAcceptedAssemblyVersionId: item.entry.acceptedAssemblyVersionId,
      sourceCanonicalDraftChecksum: item.entry.canonicalDraftChecksum,
      sourceComponentId: item.entry.componentId,
      sourceComponentDigest: item.entry.componentDigest,
      targetComponentId,
      stagedComponentDigest: await stagedDigest('region', staged),
      sourceProvenance: pinned ? { ...pinned, regionId: target.regionId } : undefined,
    });
  }
  for (const { selection, item, targetComponentId } of resolved.filter(
    (resolvedItem) => resolvedItem.selection.target.kind === 'spacer'
  )) {
    const target = selection.target as GapTarget;
    const index = gapIndex(next, target.leftRegionId, target.rightRegionId);
    const original = next.spacers.find((spacer) => spacer.junctionIndex === index);
    const source = item.value as DesignSpacer;
    const staged: DesignSpacer = {
      id: original?.id ?? source.id,
      name: source.name,
      sequence: source.sequence,
      junctionIndex: index,
      anchor: { leftRegionId: target.leftRegionId, rightRegionId: target.rightRegionId },
    };
    next.spacers = [...next.spacers.filter((spacer) => spacer.junctionIndex !== index), staged];
    receipts.push({
      kind: 'spacer',
      sourceAcceptedAssemblyVersionId: item.entry.acceptedAssemblyVersionId,
      sourceCanonicalDraftChecksum: item.entry.canonicalDraftChecksum,
      sourceComponentId: item.entry.componentId,
      sourceComponentDigest: item.entry.componentDigest,
      targetComponentId,
      stagedComponentDigest: await stagedDigest('spacer', staged),
    });
  }
  for (const { selection, item, targetComponentId } of resolved.filter(
    (resolvedItem) => resolvedItem.selection.target.kind === 'join'
  )) {
    const target = selection.target as GapTarget;
    const index = gapIndex(next, target.leftRegionId, target.rightRegionId);
    if (
      item.record.projectionInput.assemblyMethod !== next.assemblyMethod ||
      item.record.projectionInput.topology !== next.topology ||
      !sameGapContext(item.record, item.sourceIndex, next, index)
    ) {
      throw new Error(
        'Historical join is incompatible with this method or neighboring parts/spacer.'
      );
    }
    const sourceStart = startOfRegion(
      {
        regions: sourceDesign(item.record).regions,
        spacers: sourceDesign(item.record).spacers,
      },
      item.sourceIndex
    );
    const targetStart = startOfRegion(next, index);
    const delta = targetStart - sourceStart;
    const staged = remapJoin(item.value as HomologyRegion | GoldenGateJunction, index, delta);
    if (next.assemblyMethod === 'goldengate') {
      next.goldenGateJunctions = [
        ...(next.goldenGateJunctions ?? []).filter((join) => join.junctionIndex !== index),
        staged as GoldenGateJunction,
      ];
    } else {
      next.homologyRegions = [
        ...next.homologyRegions.filter((join) => join.junctionIndex !== index),
        staged as HomologyRegion,
      ];
    }
    receipts.push({
      kind: 'join',
      sourceAcceptedAssemblyVersionId: item.entry.acceptedAssemblyVersionId,
      sourceCanonicalDraftChecksum: item.entry.canonicalDraftChecksum,
      sourceComponentId: item.entry.componentId,
      sourceComponentDigest: item.entry.componentDigest,
      targetComponentId,
      stagedComponentDigest: await stagedDigest('join', staged),
    });
  }
  for (const { selection, item, targetComponentId } of resolved.filter(
    (resolvedItem) => resolvedItem.selection.target.kind === 'primer-pair'
  )) {
    const target = selection.target as Extract<HistoricalAssemblyTarget, { kind: 'primer-pair' }>;
    const index = next.regions.findIndex((region) => region.id === target.regionId);
    if (index < 0 || item.record.projectionInput.assemblyMethod !== next.assemblyMethod) {
      throw new Error('Historical primer pair has no compatible target region or method.');
    }
    const sourceDesignValue = sourceDesign(item.record);
    if (!samePrimerContext(sourceDesignValue, item.sourceIndex, next, index)) {
      throw new Error('Historical primer pair does not match the target part and neighbors.');
    }
    const source = item.value as DesignPrimerPair;
    const delta = startOfRegion(next, index) - startOfRegion(sourceDesignValue, item.sourceIndex);
    const remap = (primer: DesignPrimerPair['forward']) => {
      const sourceGap =
        primer.junctionIndex === null ? null : pairAt(item.record, primer.junctionIndex);
      return {
        ...primer,
        fragmentIndex: index,
        pbs: { ...primer.pbs, start: primer.pbs.start + delta, end: primer.pbs.end + delta },
        junctionIndex:
          sourceGap === null
            ? null
            : gapIndex(next, sourceGap.leftRegionId, sourceGap.rightRegionId),
      };
    };
    const staged: DesignPrimerPair = {
      fragmentIndex: index,
      forward: remap(source.forward),
      reverse: remap(source.reverse),
    };
    next.designPrimers = [
      ...next.designPrimers.filter((pair) => pair.fragmentIndex !== index),
      staged,
    ];
    receipts.push({
      kind: 'primer-pair',
      sourceAcceptedAssemblyVersionId: item.entry.acceptedAssemblyVersionId,
      sourceCanonicalDraftChecksum: item.entry.canonicalDraftChecksum,
      sourceComponentId: item.entry.componentId,
      sourceComponentDigest: item.entry.componentDigest,
      targetComponentId,
      stagedComponentDigest: await stagedDigest('primer-pair', staged),
    });
  }
  next.historicalComponentSources = [
    ...(next.historicalComponentSources ?? []).filter(
      (old) =>
        !receipts.some(
          (receipt) =>
            receipt.kind === old.kind && receipt.targetComponentId === old.targetComponentId
        )
    ),
    ...receipts,
  ];
  next.version = design.version + 1;
  next.updatedAt = new Date();
  next.assemblyState = 'drafting';
  next.validationErrors = [];
  next.status = 'draft';
  next.activeAcceptedAssemblyVersionId = null;
  next.historicalComponentValidatedVersion = undefined;
  next.assemblyResult = undefined;
  next.assemblyMethodDrafts = undefined;
  return next;
}

export async function assertHistoricalComponentSelectionsCurrent(
  design: SequenceDesign
): Promise<void> {
  const receipts = design.historicalComponentSources ?? [];
  if (receipts.length === 0) return;
  const current = new Map<string, unknown>();
  const add = (kind: ComponentKind, id: string, value: unknown) => {
    const mapKey = key([kind, id]);
    if (current.has(mapKey)) throw new Error(`Duplicate staged ${kind} target ${id}.`);
    current.set(mapKey, value);
  };
  for (const region of design.regions)
    add('region', targetId({ kind: 'region', regionId: region.id }), region);
  for (const spacer of design.spacers) {
    const index = spacer.junctionIndex;
    if (
      index < 0 ||
      index >= design.regions.length ||
      (index === design.regions.length - 1 && design.topology !== 'circular')
    )
      continue;
    const leftRegionId = design.regions[index].id;
    const rightRegionId = design.regions[(index + 1) % design.regions.length].id;
    add('spacer', targetId({ kind: 'spacer', leftRegionId, rightRegionId }), spacer);
  }
  const joins =
    design.assemblyMethod === 'goldengate'
      ? (design.goldenGateJunctions ?? [])
      : design.homologyRegions;
  for (const join of joins) {
    const index = join.junctionIndex;
    if (
      index < 0 ||
      index >= design.regions.length ||
      (index === design.regions.length - 1 && design.topology !== 'circular')
    )
      continue;
    const leftRegionId = design.regions[index].id;
    const rightRegionId = design.regions[(index + 1) % design.regions.length].id;
    add('join', targetId({ kind: 'join', leftRegionId, rightRegionId }), join);
  }
  for (const pair of design.designPrimers) {
    const region = design.regions[pair.fragmentIndex];
    if (region) add('primer-pair', targetId({ kind: 'primer-pair', regionId: region.id }), pair);
  }
  for (const receipt of receipts) {
    const item = current.get(key([receipt.kind, receipt.targetComponentId]));
    const digest = item === undefined ? null : await stagedDigest(receipt.kind, item);
    if (digest !== receipt.stagedComponentDigest) {
      throw new Error(
        `Staged historical ${receipt.kind} changed; restage or explicitly clear its historical choice.`
      );
    }
  }
}

type ComputedAssemblyChoices = Pick<
  SequenceDesign,
  'homologyRegions' | 'goldenGateJunctions' | 'designPrimers'
>;

function physicalJoin(join: HomologyRegion | GoldenGateJunction): unknown {
  if ('encoding' in join) {
    return {
      junctionIndex: join.junctionIndex,
      junctionPosition: join.junctionPosition,
      start: join.start,
      end: join.end,
      encoding: join.encoding,
      templateBasis: join.templateBasis,
      sequence: join.metadata?.sequence,
    };
  }
  return {
    junctionIndex: join.junctionIndex,
    junctionPosition: join.junctionPosition,
    offset: join.offset,
    overhangStart: join.overhangStart,
    overhangEnd: join.overhangEnd,
    overhang: join.overhang,
    source: join.source,
    isValid: join.isValid,
  };
}

function physicalPrimer(pair: DesignPrimerPair): unknown {
  const primer = (value: DesignPrimerPair['forward']) => ({
    sequence: value.sequence,
    pbs: value.pbs,
    overhang: value.overhang,
    goldenGateOverhang: value.goldenGateOverhang,
    direction: value.direction,
    fragmentIndex: value.fragmentIndex,
    junctionIndex: value.junctionIndex,
  });
  return {
    fragmentIndex: pair.fragmentIndex,
    forward: primer(pair.forward),
    reverse: primer(pair.reverse),
  };
}

export async function preserveHistoricalComputedChoices(
  design: SequenceDesign,
  computed: ComputedAssemblyChoices
): Promise<ComputedAssemblyChoices> {
  await assertHistoricalComponentSelectionsCurrent(design);
  if (!design.historicalComponentSources?.length) return computed;
  const homologyRegions = [...computed.homologyRegions];
  const goldenGateJunctions = computed.goldenGateJunctions
    ? [...computed.goldenGateJunctions]
    : undefined;
  const designPrimers = [...computed.designPrimers];
  for (const receipt of design.historicalComponentSources) {
    if (receipt.kind === 'join') {
      const index = design.regions.findIndex((region, candidate) => {
        if (candidate === design.regions.length - 1 && design.topology !== 'circular') return false;
        return (
          targetId({
            kind: 'join',
            leftRegionId: region.id,
            rightRegionId: design.regions[(candidate + 1) % design.regions.length].id,
          }) === receipt.targetComponentId
        );
      });
      if (index < 0) throw new Error('A selected historical join no longer has its target gap.');
      const selected =
        design.assemblyMethod === 'goldengate'
          ? design.goldenGateJunctions?.find((join) => join.junctionIndex === index)
          : design.homologyRegions.find((join) => join.junctionIndex === index);
      const candidate =
        design.assemblyMethod === 'goldengate'
          ? goldenGateJunctions?.find((join) => join.junctionIndex === index)
          : homologyRegions.find((join) => join.junctionIndex === index);
      if (
        !selected ||
        !candidate ||
        canonicalizeAcceptedAssemblyValue(physicalJoin(selected)) !==
          canonicalizeAcceptedAssemblyValue(physicalJoin(candidate))
      ) {
        throw new Error(
          'The selected historical join differs from the computed target; review or change the choice before validation.'
        );
      }
      if (design.assemblyMethod === 'goldengate' && goldenGateJunctions) {
        goldenGateJunctions.splice(
          goldenGateJunctions.findIndex((join) => join.junctionIndex === index),
          1,
          selected as GoldenGateJunction
        );
      } else {
        homologyRegions.splice(
          homologyRegions.findIndex((join) => join.junctionIndex === index),
          1,
          selected as HomologyRegion
        );
      }
    }
    if (receipt.kind === 'primer-pair') {
      const index = design.regions.findIndex(
        (region) =>
          targetId({ kind: 'primer-pair', regionId: region.id }) === receipt.targetComponentId
      );
      if (index < 0) throw new Error('A selected historical primer pair lost its target region.');
      const selected = design.designPrimers.find((pair) => pair.fragmentIndex === index);
      const candidate = designPrimers.find((pair) => pair.fragmentIndex === index);
      if (
        !selected ||
        !candidate ||
        canonicalizeAcceptedAssemblyValue(physicalPrimer(selected)) !==
          canonicalizeAcceptedAssemblyValue(physicalPrimer(candidate))
      ) {
        throw new Error(
          'The selected historical primer pair differs from the computed target; review or change the choice before validation.'
        );
      }
      designPrimers.splice(
        designPrimers.findIndex((pair) => pair.fragmentIndex === index),
        1,
        selected
      );
    }
  }
  return { homologyRegions, goldenGateJunctions, designPrimers };
}
