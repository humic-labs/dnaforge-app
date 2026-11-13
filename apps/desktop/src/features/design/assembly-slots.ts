import type { DesignRegion, SequenceDesign } from './types';
import type { GoldenGateSchemaSlot } from './golden-gate-schema';

export function emptyDesignRegion(name = 'Empty slot'): Omit<DesignRegion, 'id'> {
  return {
    sourceSequenceId: 'placeholder',
    sourceSequenceName: name,
    sourceStart: 0,
    sourceEnd: 0,
    sequence: '',
    annotations: [],
    isPlaceholder: true,
  };
}

export function normalizeRegionInput(region: DesignRegion): DesignRegion {
  if (!region.isPlaceholder) {
    const sourceType = region.sourceType ?? (region.rdOverhangs ? 'rd' : 'pcr');
    return region.isPlaceholder === false && region.sourceType === sourceType
      ? region
      : { ...region, isPlaceholder: false, sourceType };
  }
  if (region.sequence.length > 0)
    throw new Error('An empty assembly position cannot contain sequence.');
  const empty: DesignRegion = {
    ...emptyDesignRegion(region.sourceSequenceName),
    id: region.id,
    ...(region.colorIndex === undefined ? {} : { colorIndex: region.colorIndex }),
    ...(region.schemaSlotId === undefined ? {} : { schemaSlotId: region.schemaSlotId }),
    ...(region.mocloStageOutput ? { mocloStageOutput: region.mocloStageOutput } : {}),
  };
  const keys = Object.keys(empty) as Array<keyof DesignRegion>;
  return Object.keys(region).length === keys.length &&
    keys.every((key) =>
      key === 'annotations' ? region.annotations.length === 0 : region[key] === empty[key]
    )
    ? region
    : empty;
}

export function normalizeAssemblySlots(design: SequenceDesign): SequenceDesign {
  const regions = design.regions ?? [];
  const slots = design.goldenGateSchema?.slots;
  const legacy =
    slots?.length === regions.length && regions.every((r) => r.schemaSlotId === undefined);
  const normalized = regions.map((region, index) =>
    normalizeRegionInput(legacy ? { ...region, schemaSlotId: slots![index].id } : region)
  );
  const backboneSequenceId = schemaBackboneSequenceId(design, normalized);
  return normalized.every((region, index) => region === regions[index]) &&
    backboneSequenceId === design.backboneSequenceId
    ? design
    : { ...design, regions: normalized, backboneSequenceId };
}

export function schemaBackboneSequenceId(
  design: Pick<SequenceDesign, 'goldenGateSchema' | 'backboneSequenceId'>,
  regions: readonly DesignRegion[]
): SequenceDesign['backboneSequenceId'] {
  if (!design.goldenGateSchema) return design.backboneSequenceId;
  const candidates = new Set(
    regions
      .filter(
        (region) =>
          !region.isPlaceholder && region.sourceType === 'rd' && region.ggType === 'backbone'
      )
      .map((region) => region.sourceSequenceId)
  );
  if (design.backboneSequenceId && candidates.has(design.backboneSequenceId)) {
    return design.backboneSequenceId;
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

export function schemaSlotIndexForRegion(
  design: Pick<SequenceDesign, 'goldenGateSchema'>,
  region: DesignRegion | undefined
): number {
  if (!region?.schemaSlotId) return -1;
  return design.goldenGateSchema?.slots.findIndex((slot) => slot.id === region.schemaSlotId) ?? -1;
}

export function schemaSlotForRegion(
  design: Pick<SequenceDesign, 'goldenGateSchema'>,
  region: DesignRegion | undefined
): GoldenGateSchemaSlot | undefined {
  return design.goldenGateSchema?.slots[schemaSlotIndexForRegion(design, region)];
}

export function regionForSchemaSlot(
  design: SequenceDesign,
  slotId: string
): DesignRegion | undefined {
  const matches = design.regions.filter((region) => region.schemaSlotId === slotId);
  return matches.length === 1 ? matches[0] : undefined;
}

export function withAssemblySlotStructure(
  design: SequenceDesign,
  regions: DesignRegion[]
): Pick<SequenceDesign, 'regions' | 'goldenGateSchema' | 'backboneSequenceId'> {
  const schema = design.goldenGateSchema;
  if (!schema) {
    return {
      regions: regions.map((region) => {
        const { schemaSlotId: _link, ...input } = region;
        return normalizeRegionInput(input);
      }),
      goldenGateSchema: undefined,
      backboneSequenceId: design.backboneSequenceId,
    };
  }
  if (schema.origin.type !== 'custom') {
    throw new Error('Reusable schema positions cannot be structurally edited.');
  }
  const oldRegions = new Map(design.regions.map((region) => [region.id, region]));
  const usedIds = new Set(schema.slots.map((slot) => slot.id));
  const slots: GoldenGateSchemaSlot[] = [];
  const linked = regions.map((region) => {
    const oldRegion = oldRegions.get(region.id);
    let slot = oldRegion ? schemaSlotForRegion(design, oldRegion) : undefined;
    if (oldRegion && !slot) throw new Error('Assembly position has no valid schema-slot link.');
    if (!slot) {
      const baseId = `part-${region.id}`;
      let id = baseId;
      let suffix = 2;
      while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
      usedIds.add(id);
      slot = {
        id,
        label: region.sourceSequenceName || 'Part',
        outgoingOverhang: null,
        preferredRoles: [],
      };
    }
    if (slots.some((existing) => existing.id === slot.id))
      throw new Error('Duplicate assembly position.');
    slots.push(slot);
    return normalizeRegionInput({ ...region, schemaSlotId: slot.id });
  });
  const changed =
    slots.length !== schema.slots.length ||
    slots.some((slot, index) => slot !== schema.slots[index]);
  return {
    regions: linked,
    backboneSequenceId: schemaBackboneSequenceId(design, linked),
    goldenGateSchema: changed ? { ...schema, slots, revision: schema.revision + 1 } : schema,
  };
}
