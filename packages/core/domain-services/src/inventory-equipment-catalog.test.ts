import { expect, it } from 'vitest';
import { applyInventoryCommandBatch, createInventoryState, parseInventoryState } from './inventory';
import {
  inventoryEquipmentCatalog,
  inventoryEquipmentCatalogMissingDefinitions,
  inventoryEquipmentCatalogUpdatePreview,
  type InventoryEquipmentCatalogEntry,
} from './inventory-equipment-catalog';
import type { InventoryCommand, InventoryState } from './inventory-types';

function apply(state: InventoryState, commands: readonly InventoryCommand[]): InventoryState {
  const result = applyInventoryCommandBatch(
    state,
    { expectedRevision: state.revision, commands },
    {
      at: state.lastRecordedAt + 1,
      principal: { kind: 'agent', identityId: 'catalog-acceptance' },
      authority: { kind: 'local-profile', profileKey: 'catalog-profile' },
    }
  );
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  expect(parseInventoryState(result.state)).toEqual(result.state);
  return result.state;
}
function install(state: InventoryState, entry: InventoryEquipmentCatalogEntry, suffix: number) {
  const recipe = entry.definitions.find(
    (definition) => definition.kind === 'define-equipment-recipe'
  );
  if (!recipe || recipe.kind !== 'define-equipment-recipe')
    throw new Error('Missing catalog recipe.');
  return apply(state, [
    ...inventoryEquipmentCatalogMissingDefinitions(state, entry),
    {
      kind: 'instantiate-equipment-recipe',
      recipeVersionId: entry.recipeVersionId,
      name: `Catalog acceptance ${suffix}`,
      destination: { kind: 'root' },
      components: recipe.components.map((component) => ({
        key: component.key,
        id: `catalog-instance-${suffix}:${component.key}`,
        metadata: {},
      })),
      reason: 'Synthetic catalog recipe acceptance; no physical qualification.',
    },
  ]);
}

it('installs curated alternatives without stock or invented boxes and reuses identical definitions', () => {
  let state = createInventoryState();
  for (const [index, entry] of inventoryEquipmentCatalog().entries()) {
    const beforeIds = new Set(Object.keys(state.storage));
    state = install(state, entry, index);
    const added = Object.values(state.storage).filter((item) => !beforeIds.has(item.id));
    const boxPositions = added
      .filter((item) => item.configuration.recipe?.componentKey !== 'freezer')
      .reduce(
        (total, item) => total + (item.layout.kind === 'named' ? item.layout.slots.length : 0),
        0
      );
    expect(boxPositions).toBe(entry.boxPositions);
    expect(state.vessels).toEqual({});
    expect(state.stocks).toEqual({});
    expect(inventoryEquipmentCatalogMissingDefinitions(state, entry)).toEqual([]);
  }
});

it('keeps source-backed alternatives and heterogeneous rack counts distinct', () => {
  const catalog = inventoryEquipmentCatalog();
  const thermo2 = catalog.find((entry) => entry.id === 'catalog:thermo:tsx60086:920090')!;
  const thermo3 = catalog.find((entry) => entry.id === 'catalog:thermo:tsx60086:920091')!;
  expect(thermo2.boxPositions).toBe(600);
  expect(thermo3.boxPositions).toBe(360);
  const eppendorf = catalog.find(
    (entry) => entry.id === 'catalog:eppendorf:f740hi:5c:drawer:53mm'
  )!;
  const state = install(createInventoryState(), eppendorf, 100);
  const racks = Object.values(state.storage).filter(
    (item) => item.configuration.recipe?.componentKey !== 'freezer'
  );
  expect(
    racks.filter(
      (item) => item.configuration.typeVersionId === 'catalog:eppendorf:rack:6001022210:v1'
    )
  ).toHaveLength(24);
  expect(
    racks.filter(
      (item) => item.configuration.typeVersionId === 'catalog:eppendorf:rack:6001082210:v1'
    )
  ).toHaveLength(6);
  expect(eppendorf.boxPositions).toBe(528);
  expect(eppendorf.nominalBoxClass).toContain('53 mm');
  expect(thermo2.nominalBoxClass).toContain('5.08 cm');
});

it('refuses semantic existing-ID conflicts instead of selecting a different definition', () => {
  const entry = inventoryEquipmentCatalog()[0];
  const first = entry.definitions[0];
  if (first.kind !== 'define-physical-type') throw new Error('Expected physical type.');
  const state = apply(createInventoryState(), [{ ...first, name: 'Different local definition' }]);
  const before = JSON.stringify(state);
  expect(() => inventoryEquipmentCatalogMissingDefinitions(state, entry)).toThrow('differs');
  expect(JSON.stringify(state)).toBe(before);
});

it('reuses a catalog type after exact input dimensions normalize to millimeters', () => {
  const entry = structuredClone(inventoryEquipmentCatalog()[0]);
  const first = entry.definitions[0];
  if (first.kind !== 'define-physical-type') throw new Error('Expected physical type.');
  const equivalent = {
    ...first,
    definition: {
      ...first.definition,
      geometry: {
        ...first.definition.geometry,
        external: {
          ...first.definition.geometry.external,
          width: { kind: 'known' as const, value: '1', unit: 'cm' as const },
        },
      },
    },
  };
  const custom = { ...entry, definitions: [equivalent] };
  const state = apply(createInventoryState(), custom.definitions);
  expect(inventoryEquipmentCatalogMissingDefinitions(state, custom)).toEqual([]);
  expect(state.typeVersions[first.id].definition.geometry.external.width).toEqual({
    kind: 'known',
    value: '10',
    unit: 'mm',
  });
  const parsed = parseInventoryState(JSON.parse(JSON.stringify(state)));
  const geometry = parsed.typeVersions[first.id].definition.geometry;
  Object.assign(geometry.external, { width: { kind: 'known', value: '1.00', unit: 'cm' } });
  const before = JSON.stringify(parsed);
  expect(inventoryEquipmentCatalogMissingDefinitions(parseInventoryState(parsed), custom)).toEqual(
    []
  );
  expect(JSON.stringify(parsed)).toBe(before);
  Object.assign(geometry.external, { width: { kind: 'known', value: '1.1', unit: 'cm' } });
  expect(() =>
    inventoryEquipmentCatalogMissingDefinitions(parseInventoryState(parsed), custom)
  ).toThrow('differs');
});

it('keeps conflicting F740h exterior depth unknown with both source scopes', () => {
  const entry = inventoryEquipmentCatalog().find(
    (item) => item.id === 'catalog:eppendorf:f740h:3c:drawer:53mm'
  )!;
  const root = entry.definitions.find(
    (item) => item.kind === 'define-physical-type' && item.id.includes(':f740h:')
  );
  if (!root || root.kind !== 'define-physical-type') throw new Error('Expected F740h type.');
  expect(root.definition.geometry.external.depth).toEqual({ kind: 'unknown' });
  expect(root.sources.some((source) => source.locator.includes('91.3 cm'))).toBe(true);
  expect(root.sources.some((source) => source.sha256 !== null)).toBe(true);
});

it('detaches separate catalog entries and subsequent reads from an edited caller draft', () => {
  const catalog = inventoryEquipmentCatalog();
  const first = catalog[0].definitions[0],
    second = catalog[1].definitions[0];
  if (first.kind !== 'define-physical-type' || second.kind !== 'define-physical-type')
    throw new Error('Expected types.');
  const original = second.name;
  (first as { name: string }).name = 'Edited caller draft';
  expect(second.name).toBe(original);
  const fresh = inventoryEquipmentCatalog()[0].definitions[0];
  expect(fresh.kind === 'define-physical-type' ? fresh.name : null).toBe(original);
});

it('previews new source definitions without changing inventory or the source pack', () => {
  const state = createInventoryState();
  const entry = inventoryEquipmentCatalog()[0];
  const beforeState = structuredClone(state);
  const beforeEntry = structuredClone(entry);
  const preview = inventoryEquipmentCatalogUpdatePreview(state, entry);
  expect(preview).toMatchObject({
    revision: state.revision,
    entryId: entry.id,
    name: entry.name,
    description: entry.description,
    model: entry.model,
    sources: entry.sources,
    recipeVersionId: entry.recipeVersionId,
    canApply: true,
    conflictCount: 0,
    installedReferences: [],
  });
  expect(preview.definitions.map((row) => row.status)).toEqual(entry.definitions.map(() => 'new'));
  expect(preview.definitions.map((row) => row.definition)).toEqual(entry.definitions);
  expect(state).toEqual(beforeState);
  expect(entry).toEqual(beforeEntry);
  Object.assign(preview.model, { region: 'Edited caller scope' });
  Object.assign(preview.sources[0], { locator: 'Edited caller source' });
  const first = preview.definitions[0].definition;
  if (first.kind !== 'define-physical-type') throw new Error('Expected physical type.');
  Object.assign(first.definition.geometry.external, {
    width: { kind: 'known', value: '99', unit: 'mm' },
  });
  expect(state).toEqual(beforeState);
  expect(entry).toEqual(beforeEntry);
});

it('blocks a conflicting pack and reports exact installed type and recipe references', () => {
  const entry = inventoryEquipmentCatalog()[0];
  const state = install(createInventoryState(), entry, 200);
  const [root, rack, recipe] = entry.definitions;
  if (
    root.kind !== 'define-physical-type' ||
    rack.kind !== 'define-physical-type' ||
    recipe.kind !== 'define-equipment-recipe'
  )
    throw new Error('Expected catalog type and recipe definitions.');
  const beforeState = structuredClone(state);
  const custom = {
    ...entry,
    definitions: [
      { ...root, id: `${root.typeId}:v2`, name: 'Published successor draft' },
      recipe,
      { ...rack, name: 'Conflicting existing rack definition' },
      entry.definitions[3],
    ],
  };
  const preview = inventoryEquipmentCatalogUpdatePreview(state, custom);
  expect(preview.definitions.map((row) => row.status)).toEqual([
    'new',
    'identical',
    'conflicting',
    'identical',
  ]);
  expect(preview.canApply).toBe(false);
  expect(preview.conflictCount).toBe(1);
  expect(preview.definitions[0].installedReferences).toEqual([]);
  expect(preview.definitions[1].installedReferences).toHaveLength(recipe.components.length);
  expect(preview.definitions[2].installedReferences).toHaveLength(recipe.components.length - 1);
  expect(preview.definitions[3].installedReferences).toEqual([]);
  expect(preview.installedReferences).toHaveLength(recipe.components.length);
  expect(preview.installedReferences).toContainEqual({
    item: { kind: 'storage', id: 'catalog-instance-200:freezer' },
    name: 'Catalog acceptance 200',
    typeVersionId: root.id,
    recipeVersionId: recipe.id,
  });
  Object.assign(preview.installedReferences[0].item, { id: 'Edited caller reference' });
  expect(state).toEqual(beforeState);
  expect(() => inventoryEquipmentCatalogMissingDefinitions(state, custom)).toThrow('differs');
});

it('shares semantic comparison across preview and reuse after both geometry inputs normalize', () => {
  const entry = inventoryEquipmentCatalog()[0];
  const first = entry.definitions[0];
  if (first.kind !== 'define-physical-type') throw new Error('Expected physical type.');
  const incoming = {
    ...first,
    definition: {
      ...first.definition,
      geometry: {
        ...first.definition.geometry,
        external: {
          ...first.definition.geometry.external,
          width: { kind: 'known' as const, value: '1', unit: 'in' as const },
        },
      },
    },
  };
  const state = apply(createInventoryState(), [incoming]);
  Object.assign(state.typeVersions[first.id].definition.geometry.external, {
    width: { kind: 'known', value: '2.540', unit: 'cm' },
  });
  const custom = { ...entry, definitions: [incoming] };
  const before = structuredClone(state);
  expect(inventoryEquipmentCatalogUpdatePreview(state, custom).definitions[0].status).toBe(
    'identical'
  );
  expect(inventoryEquipmentCatalogMissingDefinitions(state, custom)).toEqual([]);
  expect(state).toEqual(before);
  Object.assign(state.typeVersions[first.id].definition.geometry.external, {
    width: { kind: 'known', value: '2.541', unit: 'cm' },
  });
  expect(inventoryEquipmentCatalogUpdatePreview(state, custom).definitions[0].status).toBe(
    'conflicting'
  );
  expect(() => inventoryEquipmentCatalogMissingDefinitions(state, custom)).toThrow('differs');
});

it('rejects unsupported and malformed source commands through the strict command parser', () => {
  const state = createInventoryState();
  const entry = inventoryEquipmentCatalog()[0];
  const before = structuredClone(state);
  const malformed = {
    ...entry,
    definitions: [{ ...entry.definitions[0], undeclared: true }],
  };
  expect(() => inventoryEquipmentCatalogUpdatePreview(state, malformed)).toThrow();
  expect(() => inventoryEquipmentCatalogMissingDefinitions(state, malformed)).toThrow();
  const unsupported = {
    ...entry,
    definitions: [
      {
        kind: 'instantiate-physical-type',
        typeVersionId: 'source-type',
        id: 'source-item',
        name: 'Source item',
        destination: { kind: 'root' },
        metadata: {},
        reason: 'Must not be applied while previewing.',
      },
    ],
  } as unknown as InventoryEquipmentCatalogEntry;
  expect(() => inventoryEquipmentCatalogUpdatePreview(state, unsupported)).toThrow();
  expect(() => inventoryEquipmentCatalogMissingDefinitions(state, unsupported)).toThrow();
  expect(state).toEqual(before);
});

it('blocks conflicting definitions sharing a new pack identifier before publication', () => {
  const state = createInventoryState();
  const entry = inventoryEquipmentCatalog()[0];
  const first = entry.definitions[0];
  if (first.kind !== 'define-physical-type') throw new Error('Expected physical type.');
  const custom = {
    ...entry,
    definitions: [first, { ...first, name: 'Conflicting source content' }],
  };
  const before = structuredClone(state);
  const preview = inventoryEquipmentCatalogUpdatePreview(state, custom);
  expect(preview.definitions.map((row) => row.status)).toEqual(['conflicting', 'conflicting']);
  expect(preview.canApply).toBe(false);
  expect(preview.conflictCount).toBe(2);
  expect(() => inventoryEquipmentCatalogMissingDefinitions(state, custom)).toThrow('differs');
  expect(state).toEqual(before);
});

it('keeps identical retired definitions retired when applying a new successor from a pack', () => {
  const entry = inventoryEquipmentCatalog()[0];
  const first = entry.definitions[0];
  if (first.kind !== 'define-physical-type') throw new Error('Expected physical type.');
  const installed = install(createInventoryState(), entry, 201);
  const state = apply(installed, [
    {
      kind: 'retire-catalog-version',
      target: { kind: 'type-version', versionId: first.id },
      reason: 'Retain installed equipment but stop selecting this version.',
    },
    {
      kind: 'retire-catalog-version',
      target: { kind: 'recipe-version', versionId: entry.recipeVersionId },
      reason: 'Retain the exact installed recipe.',
    },
  ]);
  const successor = { ...first, id: `${first.typeId}:v2`, name: 'New catalog successor' };
  const custom = { ...entry, definitions: [...entry.definitions, successor] };
  const before = structuredClone(state);
  const preview = inventoryEquipmentCatalogUpdatePreview(state, custom);
  expect(preview.canApply).toBe(true);
  expect(preview.definitions.map((row) => row.status)).toEqual([
    ...entry.definitions.map(() => 'identical'),
    'new',
  ]);
  expect(state).toEqual(before);
  const missing = inventoryEquipmentCatalogMissingDefinitions(state, custom);
  expect(missing).toEqual([successor]);
  const applied = apply(state, missing);
  expect(applied.typeVersions[first.id]).toEqual(before.typeVersions[first.id]);
  expect(applied.recipeVersions[entry.recipeVersionId]).toEqual(
    before.recipeVersions[entry.recipeVersionId]
  );
  expect(applied.storage).toEqual(before.storage);
  expect(applied.stocks).toEqual(before.stocks);
});

it('revalidates preview revision and exact identifiers through the ordinary reducer on apply', () => {
  const state = createInventoryState();
  const entry = inventoryEquipmentCatalog()[0];
  const preview = inventoryEquipmentCatalogUpdatePreview(state, entry);
  const first = entry.definitions[0];
  if (first.kind !== 'define-physical-type') throw new Error('Expected physical type.');
  const changed = apply(state, [{ ...first, name: 'Local definition accepted after preview' }]);
  const before = structuredClone(changed);
  const context = {
    at: changed.lastRecordedAt + 1,
    principal: { kind: 'agent' as const, identityId: 'catalog-acceptance' },
    authority: { kind: 'local-profile' as const, profileKey: 'catalog-profile' },
  };
  const commands = preview.definitions.map((row) => row.definition);
  expect(
    applyInventoryCommandBatch(
      changed,
      {
        expectedRevision: preview.revision,
        commands,
      },
      context
    )
  ).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
  expect(
    applyInventoryCommandBatch(
      changed,
      {
        expectedRevision: changed.revision,
        commands,
      },
      context
    )
  ).toMatchObject({ ok: false, code: 'ID_ALREADY_EXISTS' });
  expect(() => inventoryEquipmentCatalogMissingDefinitions(changed, entry)).toThrow('differs');
  expect(changed).toEqual(before);
});

it('adds source-scoped advertised ranges without changing previously published physical definitions', () => {
  for (const entry of inventoryEquipmentCatalog()) {
    const legacyDefinitions = entry.definitions.filter(
      (row) => row.kind !== 'record-temperature-claim'
    );
    const state = apply(createInventoryState(), legacyDefinitions);
    const before = structuredClone(state);
    const missing = inventoryEquipmentCatalogMissingDefinitions(state, entry);
    expect(missing).toHaveLength(1);
    const claim = missing[0];
    if (claim.kind !== 'record-temperature-claim') throw new Error('Expected advertised range.');
    expect(claim.subject.kind).toBe('type-version');
    expect(claim.assertion).toEqual({
      kind: 'specified-setpoint-range',
      range: { minimum: { value: '-86', unit: 'C' }, maximum: { value: '-50', unit: 'C' } },
    });
    expect(claim.observedAt).toBeNull();
    expect(claim.source?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(claim.source?.locator).toContain(
      entry.model.manufacturer === 'Eppendorf' && entry.model.model === 'F740h'
        ? 'Page 67'
        : entry.model.manufacturer === 'Eppendorf'
          ? 'Page 110'
          : 'Page 3'
    );
    const added = apply(state, missing);
    expect(added.typeVersions).toEqual(before.typeVersions);
    expect(added.recipeVersions).toEqual(before.recipeVersions);
    expect(added.fitEvidence).toEqual(before.fitEvidence);
    expect(added.equipmentSetpoints).toEqual({});
    expect(added.storageRequirements).toEqual({});
    expect(Object.values(added.temperatureClaims)).toHaveLength(1);
    expect(inventoryEquipmentCatalogMissingDefinitions(added, entry)).toEqual([]);
  }
});

it('does not reactivate a withdrawn catalog range or overwrite a conflicting range', () => {
  const entry = inventoryEquipmentCatalog()[0];
  const installed = install(createInventoryState(), entry, 202);
  const claim = entry.definitions.find((row) => row.kind === 'record-temperature-claim')!;
  if (claim.kind !== 'record-temperature-claim') throw new Error('Expected advertised range.');
  const state = apply(installed, [
    {
      kind: 'withdraw-temperature-claim',
      claimId: claim.id,
      reason: 'Local source scope has been withdrawn explicitly.',
    },
  ]);
  const before = structuredClone(state);
  expect(inventoryEquipmentCatalogMissingDefinitions(state, entry)).toEqual([]);
  const preview = inventoryEquipmentCatalogUpdatePreview(state, entry);
  expect(preview.definitions.find((row) => row.definition.id === claim.id)).toMatchObject({
    status: 'identical',
    installedReferences: [{ item: { kind: 'storage', id: 'catalog-instance-202:freezer' } }],
  });
  const conflict = {
    ...entry,
    definitions: [
      {
        ...claim,
        assertion: {
          kind: 'specified-setpoint-range' as const,
          range: {
            minimum: { value: '-90', unit: 'C' as const },
            maximum: { value: '-60', unit: 'C' as const },
          },
        },
      },
    ],
  };
  expect(inventoryEquipmentCatalogUpdatePreview(state, conflict)).toMatchObject({
    canApply: false,
    conflictCount: 1,
  });
  expect(() => inventoryEquipmentCatalogMissingDefinitions(state, conflict)).toThrow('differs');
  expect(state).toEqual(before);
});

it('compares normalized signed ranges without confusing source provenance with qualification', () => {
  const entry = inventoryEquipmentCatalog()[0];
  const installed = install(createInventoryState(), entry, 203);
  const claim = entry.definitions.find((row) => row.kind === 'record-temperature-claim')!;
  if (claim.kind !== 'record-temperature-claim') throw new Error('Expected advertised range.');
  const equivalent = {
    ...entry,
    definitions: [
      {
        ...claim,
        assertion: {
          kind: 'specified-setpoint-range' as const,
          range: {
            minimum: { value: '-86.000', unit: 'C' as const },
            maximum: { value: '-50.00', unit: 'C' as const },
          },
        },
      },
    ],
  };
  expect(inventoryEquipmentCatalogMissingDefinitions(installed, equivalent)).toEqual([]);
  const installedClaim = {
    ...entry,
    definitions: [
      {
        ...claim,
        subject: {
          kind: 'installed' as const,
          item: { kind: 'storage' as const, id: 'catalog-instance-203:freezer' },
          configurationRevision: 1,
        },
      },
    ],
  };
  expect(() => inventoryEquipmentCatalogUpdatePreview(installed, installedClaim)).toThrow(
    'specified type setpoint range'
  );
  const qualification = {
    ...entry,
    definitions: [
      {
        ...claim,
        subject: {
          kind: 'installed' as const,
          item: { kind: 'storage' as const, id: 'catalog-instance-203:freezer' },
          configurationRevision: 1,
        },
        assertion: {
          kind: 'qualified-envelope' as const,
          range: claim.assertion.range,
          atSetpoint: { value: '-80', unit: 'C' as const },
          assumptions: 'A brochure cannot qualify an installed unit.',
        },
      },
    ],
  };
  expect(() => inventoryEquipmentCatalogMissingDefinitions(installed, qualification)).toThrow(
    'specified type setpoint range'
  );
});
