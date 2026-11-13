import { beforeEach, describe, expect, it } from 'vitest';
import { hydrateDesign, partializeDesigns, useDesignStore } from './store';
import { projectAssemblySlots } from './slot-projection';
import type { GoldenGateAssemblySchema } from './golden-gate-schema';
import type { DesignRegion } from './types';
import { normalizeAssemblySlots, regionForSchemaSlot, schemaSlotForRegion } from './assembly-slots';

const schema: GoldenGateAssemblySchema = {
  id: 'slot-identity',
  name: 'Slot identity',
  revision: 1,
  origin: { type: 'custom' },
  enzyme: 'BsaI',
  slots: ['first', 'second'].map((id) => ({
    id,
    label: id,
    outgoingOverhang: null,
    preferredRoles: [],
  })),
};
const blank = {
  sourceSequenceId: 'placeholder',
  sourceSequenceName: 'Empty slot',
  sourceStart: 0,
  sourceEnd: 0,
  sequence: '',
  annotations: [],
  isPlaceholder: true,
};

function newDesign(withSchema = true) {
  const store = useDesignStore.getState();
  const id = store.createDesign('Slot identity', 'circular', 'goldengate');
  if (withSchema) {
    expect(store.setGoldenGateSchema(id, schema, 0).status).toBe('applied');
  }
  return { id, store, read: () => useDesignStore.getState().designs[id] };
}

describe('shared assembly position identity', () => {
  beforeEach(() =>
    useDesignStore.setState({ designs: {}, draftDesignIds: {}, activeDesignId: null })
  );

  it('creates schema positions with explicit links and no input route', () => {
    const { read } = newDesign();
    expect(read().regions.map((r) => r.schemaSlotId)).toEqual(['first', 'second']);
    expect(read().regions.every((r) => r.isPlaceholder && r.sourceType === undefined)).toBe(true);
    expect(projectAssemblySlots(read()).map((r) => r.sourceType)).toEqual([null, null]);
    expect(read().designPrimers).toEqual([]);
  });

  it('tracks the schema destination backbone through fill, replace, clear and reopen', () => {
    const { id, store, read } = newDesign();
    const positionId = read().regions[1].id;
    const input = {
      ...blank,
      isPlaceholder: false,
      sourceType: 'rd' as const,
      ggType: 'backbone' as const,
    };
    store.updateRegion(id, positionId, { ...input, sourceSequenceId: 'vector-a' });
    expect(read().backboneSequenceId).toBe('vector-a');
    expect(hydrateDesign({ ...read(), backboneSequenceId: null }).backboneSequenceId).toBe(
      'vector-a'
    );
    store.updateRegion(id, positionId, { ...input, sourceSequenceId: 'vector-b' });
    expect(read().backboneSequenceId).toBe('vector-b');
    store.clearRegion(id, positionId);
    expect(read().backboneSequenceId).toBeNull();
    expect(read().regions[1].schemaSlotId).toBe('second');
    expect(read().designPrimers).toEqual([]);
  });

  it('does not assign a route to freeform empty positions, including legacy callers', () => {
    const { id, store, read } = newDesign(false);
    store.addRegion(id, { ...blank, sourceType: 'pcr' });
    store.insertRegionAt(id, 0, { ...blank, sourceType: 'rd', rdSourceEnzyme: 'BsaI' });
    for (const region of read().regions) {
      expect(region.sourceType).toBeUndefined();
      expect(region.rdSourceEnzyme).toBeUndefined();
      expect(region.schemaSlotId).toBeUndefined();
    }
  });

  it('preserves the position link through filling and clearing; incoming content cannot replace it', () => {
    const { id, store, read } = newDesign();
    const positionId = read().regions[0].id;
    store.updateRegion(id, positionId, {
      sourceSequenceId: 'managed-source',
      sourceSequenceName: 'Example source',
      sourceStart: 0,
      sourceEnd: 1,
      sequence: 'N',
      annotations: [],
      isPlaceholder: false,
      sourceType: 'rd',
      rdSourceEnzyme: 'BsaI',
      schemaSlotId: 'second',
    });
    expect(read().regions[0]).toMatchObject({
      id: positionId,
      schemaSlotId: 'first',
      sourceType: 'rd',
    });
    store.clearRegion(id, positionId);
    expect(read().regions[0]).toMatchObject({
      id: positionId,
      schemaSlotId: 'first',
      isPlaceholder: true,
    });
    expect(read().regions[0].sourceType).toBeUndefined();
    expect(read().regions[0].rdSourceEnzyme).toBeUndefined();
  });

  it('keeps custom schema definitions with their positions during insert, move and remove', () => {
    const { id, store, read } = newDesign();
    store.insertRegionAt(id, 1, blank);
    const inserted = read().regions[1];
    expect(inserted.schemaSlotId).toBe(read().goldenGateSchema!.slots[1].id);
    store.reorderRegions(
      id,
      read()
        .regions.map((r) => r.id)
        .reverse()
    );
    expect(read().regions.map((r) => r.schemaSlotId)).toEqual(
      read().goldenGateSchema!.slots.map((s) => s.id)
    );
    store.removeRegion(id, inserted.id);
    expect(read().regions.map((r) => r.schemaSlotId)).toEqual(['second', 'first']);
    expect(read().goldenGateSchema!.slots.map((s) => s.id)).toEqual(['second', 'first']);
  });

  it('migrates legacy saved positions once, preserving their content and schema snapshot', () => {
    const { read } = newDesign();
    const legacy = JSON.parse(JSON.stringify(read()));
    for (const region of legacy.regions) {
      delete region.schemaSlotId;
      region.sourceType = 'pcr';
    }
    legacy.regions[0] = {
      ...legacy.regions[0],
      isPlaceholder: false,
      sourceSequenceId: 'managed-source',
      sequence: 'N',
      sourceEnd: 1,
    };
    const migrated = hydrateDesign(legacy);
    expect(migrated.regions.map((r) => r.schemaSlotId)).toEqual(['first', 'second']);
    expect(migrated.regions[0].sequence).toBe('N');
    expect(migrated.regions[0].sourceSequenceId).toBe('managed-source');
    expect(migrated.regions[1].sourceType).toBeUndefined();
    expect(migrated.goldenGateSchema).toEqual(legacy.goldenGateSchema);
    expect(migrated.version).toBe(legacy.version);
    const saved = JSON.parse(JSON.stringify(partializeDesigns({ [migrated.id]: migrated })))[
      migrated.id
    ];
    expect(hydrateDesign(saved).regions).toEqual(saved.regions);
  });

  it('never reassigns explicit links using array position when loading', () => {
    const { read } = newDesign();
    const design = read();
    const reversed = { ...design, regions: [...design.regions].reverse() };
    expect(hydrateDesign(reversed).regions.map((r) => r.schemaSlotId)).toEqual(['second', 'first']);
  });

  it('normalizes a single legacy empty position before the early hydration return', () => {
    const { read } = newDesign(false);
    const legacy = {
      ...read(),
      regions: [{ id: 'empty', ...blank, sourceType: 'pcr' } as DesignRegion],
    };
    expect(hydrateDesign(legacy).regions[0].sourceType).toBeUndefined();
  });

  it('resolves definitions and occupants by identity, not array position', () => {
    const { read } = newDesign();
    const design = { ...read(), regions: [...read().regions].reverse() };
    expect(schemaSlotForRegion(design, design.regions[0])?.id).toBe('second');
    expect(regionForSchemaSlot(design, 'first')?.id).toBe(design.regions[1].id);
    const broken = { ...design.regions[0], schemaSlotId: 'missing' };
    expect(schemaSlotForRegion(design, broken)).toBeUndefined();
    const ambiguous = {
      ...design,
      regions: [design.regions[0], { ...design.regions[1], schemaSlotId: 'second' }],
    };
    expect(regionForSchemaSlot(ambiguous, 'second')).toBeUndefined();
  });

  it('normalizes once without continually republishing unchanged state', () => {
    const { read } = newDesign();
    const normalized = normalizeAssemblySlots(read());
    expect(normalizeAssemblySlots(normalized)).toBe(normalized);
  });

  it('does not discard sequence just because an inconsistent document calls it empty', () => {
    const { read } = newDesign();
    const design = read();
    const invalid = {
      ...design,
      regions: [{ ...design.regions[0], sequence: 'N' }, design.regions[1]],
    };
    expect(() => normalizeAssemblySlots(invalid)).toThrow('cannot contain sequence');
    expect(invalid.regions[0].sequence).toBe('N');
  });
});
