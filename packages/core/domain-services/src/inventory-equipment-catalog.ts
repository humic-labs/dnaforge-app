import type {
  InventoryConfigurationCommand,
  InventoryDimensions,
  InventoryEquipmentModel,
  InventoryGeometry,
  InventorySourceReference,
} from './inventory-configuration-types';
import type { InventoryPhysicalItem, InventoryState } from './inventory-types';
import type { InventoryTemperatureCommand } from './inventory-temperature-types';
import type { MetadataFieldDefinition } from './metadata-fields';
import { parseInventoryCommand } from './inventory-validation';
import { normalizeInventoryGeometry } from './inventory-geometry';
import { normalizeInventoryTemperatureRange } from './inventory-temperature';

export type InventoryCatalogDefinition = Extract<
  InventoryConfigurationCommand | InventoryTemperatureCommand,
  {
    kind:
      | 'define-physical-type'
      | 'define-equipment-recipe'
      | 'record-fit-evidence'
      | 'record-temperature-claim';
  }
>;

export interface InventoryEquipmentCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly model: InventoryEquipmentModel;
  readonly description: string;
  readonly sources: readonly InventorySourceReference[];
  readonly recipeVersionId: string;
  readonly nominalBoxClass: string;
  readonly boxPositions: number;
  readonly definitions: readonly InventoryCatalogDefinition[];
}

export interface InventoryCatalogInstalledReference {
  readonly item: InventoryPhysicalItem;
  readonly name: string;
  readonly typeVersionId: string | null;
  readonly recipeVersionId: string | null;
}

export interface InventoryCatalogDefinitionUpdatePreview {
  readonly definition: InventoryCatalogDefinition;
  readonly status: 'new' | 'identical' | 'conflicting';
  readonly installedReferences: readonly InventoryCatalogInstalledReference[];
}

export interface InventoryEquipmentCatalogUpdatePreview {
  readonly revision: number;
  readonly entryId: string;
  readonly name: string;
  readonly description: string;
  readonly model: InventoryEquipmentModel;
  readonly sources: readonly InventorySourceReference[];
  readonly recipeVersionId: string;
  readonly canApply: boolean;
  readonly conflictCount: number;
  readonly definitions: readonly InventoryCatalogDefinitionUpdatePreview[];
  readonly installedReferences: readonly InventoryCatalogInstalledReference[];
}

const thermoSource = (locator: string): InventorySourceReference => ({
  url: 'https://assets.thermofisher.com/TFS-Assets/LED/brochures/TSX-ULT-Freezer-Green-Brochure_Americas.pdf',
  title: 'Thermo Scientific TSX Series Ultra-Low Freezers',
  locator,
  readAt: '2026-11-14',
  documentRevision: null,
  sha256: '2b5c042164560c52d01172c2a5ba148d130106e664184501771dadb316496c56',
});
const eppendorfSource = (locator: string): InventorySourceReference => ({
  url: 'https://www.eppendorf.com/product-media/doc/en/236365/Freezers_Brochure_F740-Series-green_Protect-What-Matters.pdf',
  title: 'Protect What Matters: CryoCube F740 Series',
  locator,
  readAt: '2026-11-14',
  documentRevision: 'AN.02011.020/EN6/ESE',
  sha256: 'bd1bcfb77da253ee9132aec0e036dc05410d208510e3189757337a92e7229c52',
});
const eppendorfTemperatureSource = (model: string): InventorySourceReference => ({
  url:
    model === 'F740h'
      ? 'https://www.eppendorf.com/product-media/doc/en/227509/Freezers_Operating-manual_CryoCube-F740h.pdf'
      : 'https://www.eppendorf.com/product-media/doc/en/230895/Freezers_Operating-manual_CryoCube-F740hi-hiw.pdf',
  title:
    model === 'F740h'
      ? 'CryoCube F740h Operating Manual'
      : 'CryoCube F740hi, F740hiw Operating Manual',
  locator:
    model === 'F740h'
      ? 'Page 67, section 10.7.1, setting range −50 °C to −86 °C; version overview page 8.'
      : 'Page 110, section 12.8.1, setting range −50 °C to −86 °C; version overview page 10.',
  readAt: '2026-11-16',
  documentRevision:
    model === 'F740h'
      ? 'Version 04, August 2020'
      : 'Version 03, August 2020; software version 2.1.5.202',
  sha256:
    model === 'F740h'
      ? '1394853034f52e1114517ad8857848d8ac7ac58656647d1eef59c489a8be39ae'
      : '4d3725868e16d4ab1eaecf0f2cb917bc0b7b7c48a635e7c0206ee5fd12abeb9e',
});

const cabinetFields: readonly MetadataFieldDefinition[] = [
  { key: 'asset_tag', label: 'Asset tag', type: 'text' },
  { key: 'serial_number', label: 'Serial number', type: 'text' },
  { key: 'notes', label: 'Notes', type: 'long_text' },
];
const eppendorfDepthScope: InventorySourceReference = {
  url: 'https://www.eppendorf.com/us-en/Products/Cold-Storage/ULT-Freezers/CryoCube-F740-Series-p-PF-393431',
  title: 'Eppendorf CryoCube F740 Series technical data',
  locator:
    'F740h exterior depth: US page 91.3 cm versus cited brochure 91.5 cm; region/revision scope unresolved.',
  readAt: '2026-11-14',
  documentRevision: null,
  sha256: null,
};

function dimensions(width: number, height: number, depth: number): InventoryDimensions {
  const axis = (value: number) => ({
    kind: 'known' as const,
    value: String(value),
    unit: 'mm' as const,
  });
  return { width: axis(width), height: axis(height), depth: axis(depth) };
}
function unknownDimensions(): InventoryDimensions {
  return { width: { kind: 'unknown' }, height: { kind: 'unknown' }, depth: { kind: 'unknown' } };
}
function positions(shelves: number, racks: number): string[] {
  return Array.from({ length: shelves }, (_, shelf) =>
    Array.from({ length: racks }, (_, rack) => `shelf-${shelf + 1}-rack-${rack + 1}`)
  ).flat();
}
function typeDefinition(
  id: string,
  name: string,
  slots: readonly string[],
  geometry: InventoryGeometry,
  sources: readonly InventorySourceReference[],
  description: string,
  fields: readonly MetadataFieldDefinition[] = []
): Extract<InventoryCatalogDefinition, { kind: 'define-physical-type' }> {
  return {
    kind: 'define-physical-type',
    id: `${id}:v1`,
    typeId: id,
    name,
    description,
    fields,
    sources,
    definition: {
      kind: 'storage',
      layout: { kind: 'named', slots },
      childPolicy: { kind: 'any-legal' },
      positionRules: {},
      geometry,
    },
  };
}
function supportedFit(
  id: string,
  parentVersionId: string,
  childVersionId: string,
  positionId: string,
  source: InventorySourceReference
): Extract<InventoryCatalogDefinition, { kind: 'record-fit-evidence' }> {
  return {
    kind: 'record-fit-evidence',
    id,
    parent: { kind: 'type-version', versionId: parentVersionId },
    child: { kind: 'type-version', versionId: childVersionId },
    positionId,
    orientations: [0],
    result: 'compatible',
    basis: 'manufacturer-supported',
    source,
    reason:
      'Cited rack SKU in the specified freezer configuration, upright. This does not qualify an installed unit or an arbitrary box.',
  };
}

function specifiedTemperature(
  typeVersionId: string,
  source: InventorySourceReference
): Extract<InventoryCatalogDefinition, { kind: 'record-temperature-claim' }> {
  return {
    kind: 'record-temperature-claim',
    id: `${typeVersionId}:specified-temperature:v1`,
    subject: { kind: 'type-version', versionId: typeVersionId },
    assertion: {
      kind: 'specified-setpoint-range',
      range: {
        minimum: { value: '-86', unit: 'C' },
        maximum: { value: '-50', unit: 'C' },
      },
    },
    observedAt: null,
    source,
    reason:
      'Manufacturer-specified possible setpoints for this model. No installed target, measured chamber temperature or local qualification is asserted.',
  };
}

function thermoEntries(): InventoryEquipmentCatalogEntry[] {
  const rackSource = thermoSource(
    'Page 6, nominal box classes, rack dimensions and model-specific counts.'
  );
  const cabinetSource = thermoSource('Page 3, dimensions and handle/hinge width allowance.');
  const temperatureSource = thermoSource(
    'Page 3, TSX Series Upright Freezers heading: −50 °C to −86 °C, above the TSX40086/50086/60086/70086 model table.'
  );
  const racks = [
    { sku: '920090', count: 25, label: '2-inch (source nominal label 5.08 cm)' },
    { sku: '920091', count: 15, label: '3-inch (source nominal label 7.62 cm)' },
  ].map((rack) => ({
    ...rack,
    type: typeDefinition(
      `catalog:thermo:rack:${rack.sku}`,
      `Thermo ${rack.sku} rack`,
      Array.from({ length: rack.count }, (_, i) => `box-${i + 1}`),
      { external: dimensions(140, 302, 683), usable: unknownDimensions() },
      [rackSource],
      `${rack.count} logical positions for the source's ${rack.label} class. Drawer/grid arrangement and arbitrary box dimensions remain unspecified.`
    ),
  }));
  return [
    { model: 'TSX40086', racks: 4, insideWidth: 588, outsideWidth: 719 },
    { model: 'TSX50086', racks: 5, insideWidth: 730, outsideWidth: 864 },
    { model: 'TSX60086', racks: 6, insideWidth: 873, outsideWidth: 1006 },
    { model: 'TSX70086', racks: 7, insideWidth: 1016, outsideWidth: 1148 },
  ].flatMap((spec) => {
    const slots = positions(4, spec.racks);
    const root = typeDefinition(
      `catalog:thermo:${spec.model.toLowerCase()}`,
      `Thermo ${spec.model} rack positions`,
      slots,
      {
        external: dimensions(spec.outsideWidth + 107, 1981, 955),
        usable: dimensions(spec.insideWidth, 1301, 719),
      },
      [cabinetSource, rackSource],
      'Outer width adds the stated 107 mm handle/hinge allowance to the cabinet width. Interior dimensions are cavity bounds, not insertion-clearance qualification. Four logical shelf groups follow the rack table; no removable shelf hardware is invented.',
      cabinetFields
    );
    return racks.map((rack) => {
      const boxPositions = slots.length * rack.count;
      const id = `catalog:thermo:${spec.model.toLowerCase()}:${rack.sku}`;
      const model = {
        manufacturer: 'Thermo Scientific',
        model: spec.model,
        partNumber: null,
        region: 'Americas',
        revision: null,
      };
      const recipe: Extract<InventoryCatalogDefinition, { kind: 'define-equipment-recipe' }> = {
        kind: 'define-equipment-recipe',
        id: `${id}:v1`,
        recipeId: id,
        name: `${spec.model} · ${rack.sku} · ${boxPositions} box positions`,
        description:
          'Selected full rack configuration. Adding selected components records installed racks, not boxes or stock. Model lifecycle, actual box geometry and local physical qualification remain unspecified.',
        model,
        sources: [cabinetSource, rackSource],
        components: [
          {
            key: 'freezer',
            parentKey: null,
            positionId: null,
            name: spec.model,
            typeVersionId: root.id,
          },
          ...slots.map((positionId) => ({
            key: positionId,
            parentKey: 'freezer',
            positionId,
            name: `${positionId} · ${rack.sku}`,
            typeVersionId: rack.type.id,
          })),
        ],
      };
      return {
        id,
        name: recipe.name,
        model,
        description: recipe.description,
        sources: [...recipe.sources, temperatureSource],
        recipeVersionId: recipe.id,
        nominalBoxClass: rack.label,
        boxPositions,
        definitions: [
          root,
          rack.type,
          recipe,
          ...slots.map((slot) =>
            supportedFit(`${id}:fit:${slot}:v1`, root.id, rack.type.id, slot, rackSource)
          ),
          specifiedTemperature(root.id, temperatureSource),
        ],
      };
    });
  });
}

function eppendorfEntries(): InventoryEquipmentCatalogEntry[] {
  const rackSource = eppendorfSource(
    'Page 19, rack ordering table and MAX/compatibility footnotes.'
  );
  const cabinetSource = eppendorfSource('Pages 16–17, dimensions and handle/hinge allowance.');
  return ['F740h', 'F740hi', 'F740hiw'].flatMap((modelName) =>
    [3, 5].flatMap((shelves) =>
      ['drawer', 'side-access'].map((access) => {
        const temperatureSource = eppendorfTemperatureSource(modelName);
        const drawer = access === 'drawer';
        const stem = `catalog:eppendorf:${modelName.toLowerCase()}:${shelves}c`;
        const slots = positions(shelves, 6);
        const cabinetSources =
          modelName === 'F740h'
            ? [cabinetSource, rackSource, eppendorfDepthScope]
            : [cabinetSource, rackSource];
        const root = typeDefinition(
          stem,
          `Eppendorf ${modelName} ${shelves}-compartment rack positions`,
          slots,
          {
            external:
              modelName === 'F740h'
                ? { ...dimensions(1190, 1973, 915), depth: { kind: 'unknown' } }
                : dimensions(1190, 1973, 980),
            usable: dimensions(865, 1390, 621),
          },
          cabinetSources,
          'Outer width adds the stated 80 mm handle/hinge allowance. Cavity bounds do not qualify insertion paths or open-door clearance. Compartment count differs from inner-door count. F740h exterior depth remains unknown because published regional/revision scope is unresolved.',
          cabinetFields
        );
        const specs =
          shelves === 3
            ? [{ sku: drawer ? '6001072210' : '6001071210', count: 32, height: drawer ? 449 : 444 }]
            : [
                {
                  sku: drawer ? '6001022210' : '6001021210',
                  count: 16,
                  height: drawer ? 231 : 230,
                },
                {
                  sku: drawer ? '6001082210' : '6001081210',
                  count: 24,
                  height: drawer ? 346 : 343,
                },
              ];
        const racks = specs.map((spec) =>
          typeDefinition(
            `catalog:eppendorf:rack:${spec.sku}`,
            `Eppendorf ${spec.sku} ${access} rack`,
            Array.from({ length: spec.count }, (_, i) => `box-${i + 1}`),
            {
              external: dimensions(drawer ? 140 : 139, spec.height, drawer ? 563 : 569),
              usable: unknownDimensions(),
            },
            [rackSource],
            `${spec.count} logical positions for the source's nominal 53 mm box class. No arbitrary box geometry, drawer map or reverse compatibility is inferred.`
          )
        );
        const selectedRack = (position: string) =>
          shelves === 5 && position.startsWith('shelf-5-') ? racks[1] : racks[0];
        const id = `${stem}:${access}:53mm`;
        const model = {
          manufacturer: 'Eppendorf',
          model: modelName,
          partNumber: null,
          region: null,
          revision: null,
        };
        const boxPositions = shelves === 3 ? 576 : 528;
        const recipe: Extract<InventoryCatalogDefinition, { kind: 'define-equipment-recipe' }> = {
          kind: 'define-equipment-recipe',
          id: `${id}:v1`,
          recipeId: id,
          name: `${modelName} · ${shelves} compartments · ${access} · ${boxPositions} box positions`,
          description:
            shelves === 3
              ? 'MAX-rack configuration with 18 racks and 576 nominal 53 mm box positions, distinct from the 504-box standard-rack option. No boxes or stock are created.'
              : 'Heterogeneous configuration: 24 upper racks with 16 positions plus six bottom racks with 24 positions. Adding selected components records installed racks, not boxes or stock.',
          model,
          sources: cabinetSources,
          components: [
            {
              key: 'freezer',
              parentKey: null,
              positionId: null,
              name: `${modelName} ${shelves} compartments`,
              typeVersionId: root.id,
            },
            ...slots.map((positionId) => ({
              key: positionId,
              parentKey: 'freezer',
              positionId,
              name: `${positionId} · ${selectedRack(positionId).name}`,
              typeVersionId: selectedRack(positionId).id,
            })),
          ],
        };
        return {
          id,
          name: recipe.name,
          model,
          description: recipe.description,
          sources: [...recipe.sources, temperatureSource],
          recipeVersionId: recipe.id,
          nominalBoxClass: '53 mm (source nominal two-inch label)',
          boxPositions,
          definitions: [
            root,
            ...racks,
            recipe,
            ...slots.map((slot) =>
              supportedFit(`${id}:fit:${slot}:v1`, root.id, selectedRack(slot).id, slot, rackSource)
            ),
            specifiedTemperature(root.id, temperatureSource),
          ],
        };
      })
    )
  );
}

export function inventoryEquipmentCatalog(): readonly InventoryEquipmentCatalogEntry[] {
  return [...thermoEntries(), ...eppendorfEntries()].map((entry) => structuredClone(entry));
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry
  );
}

type CatalogDefinitionState = Pick<
  InventoryState,
  'typeVersions' | 'recipeVersions' | 'fitEvidence' | 'temperatureClaims'
>;

function normalizedCatalogDefinition(definition: InventoryCatalogDefinition) {
  return definition.kind === 'define-physical-type'
    ? {
        ...definition,
        definition: {
          ...definition.definition,
          geometry: normalizeInventoryGeometry(definition.definition.geometry),
        },
      }
    : definition.kind === 'record-temperature-claim'
      ? {
          ...definition,
          assertion: {
            ...definition.assertion,
            range: normalizeInventoryTemperatureRange(definition.assertion.range),
          },
        }
      : definition;
}

function compareCatalogDefinition(
  state: CatalogDefinitionState,
  definition: InventoryCatalogDefinition
): Omit<InventoryCatalogDefinitionUpdatePreview, 'installedReferences'> {
  const parsed = parseInventoryCommand(definition);
  if (
    parsed.kind !== 'define-physical-type' &&
    parsed.kind !== 'define-equipment-recipe' &&
    parsed.kind !== 'record-fit-evidence' &&
    parsed.kind !== 'record-temperature-claim'
  )
    throw new TypeError('Catalog packs may contain only physical definitions and scoped evidence.');
  if (
    parsed.kind === 'record-temperature-claim' &&
    (parsed.subject.kind !== 'type-version' || parsed.assertion.kind !== 'specified-setpoint-range')
  )
    throw new TypeError(
      'Catalog temperature claims must describe a specified type setpoint range.'
    );
  const rows =
    parsed.kind === 'define-physical-type'
      ? state.typeVersions
      : parsed.kind === 'define-equipment-recipe'
        ? state.recipeVersions
        : parsed.kind === 'record-fit-evidence'
          ? state.fitEvidence
          : state.temperatureClaims;
  const existing = rows[parsed.id];
  if (!existing)
    return {
      definition: parsed,
      status: [
        state.typeVersions,
        state.recipeVersions,
        state.fitEvidence,
        state.temperatureClaims,
      ].some((rows) => Object.hasOwn(rows, parsed.id))
        ? 'conflicting'
        : 'new',
    };
  const { kind: _kind, ...expected } = normalizedCatalogDefinition(parsed);
  const actual = Object.fromEntries(
    Object.keys(expected).map((key) => [key, (existing as unknown as Record<string, unknown>)[key]])
  );
  if (parsed.kind === 'define-physical-type') {
    const definition = actual.definition as typeof parsed.definition;
    actual.definition = {
      ...definition,
      geometry: normalizeInventoryGeometry(definition.geometry),
    };
  }
  if (parsed.kind === 'record-temperature-claim') {
    const assertion = actual.assertion as typeof parsed.assertion;
    actual.assertion = {
      ...assertion,
      range: normalizeInventoryTemperatureRange(assertion.range),
    };
  }
  return {
    definition: parsed,
    status: canonical(actual) === canonical(expected) ? 'identical' : 'conflicting',
  };
}

function compareCatalogDefinitions(
  state: CatalogDefinitionState,
  definitions: readonly InventoryCatalogDefinition[]
): readonly Omit<InventoryCatalogDefinitionUpdatePreview, 'installedReferences'>[] {
  const comparisons = definitions.map((definition) => compareCatalogDefinition(state, definition));
  const contents = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const { definition } of comparisons) {
    const content = canonical(normalizedCatalogDefinition(definition));
    if (contents.has(definition.id) && contents.get(definition.id) !== content)
      conflicts.add(definition.id);
    contents.set(definition.id, content);
  }
  return comparisons.map((row) =>
    conflicts.has(row.definition.id) ? { ...row, status: 'conflicting' } : row
  );
}

export function inventoryEquipmentCatalogMissingDefinitions(
  state: CatalogDefinitionState,
  entry: InventoryEquipmentCatalogEntry
): readonly InventoryCatalogDefinition[] {
  const comparisons = compareCatalogDefinitions(state, entry.definitions);
  const conflict = comparisons.find((row) => row.status === 'conflicting');
  if (conflict)
    throw new Error(
      `Catalog definition ${conflict.definition.id} differs from the inventory's existing definition.`
    );
  return [
    ...new Map(
      comparisons
        .filter((row) => row.status === 'new')
        .map((row) => [row.definition.id, structuredClone(row.definition)] as const)
    ).values(),
  ];
}

export function inventoryEquipmentCatalogUpdatePreview(
  state: CatalogDefinitionState & Pick<InventoryState, 'revision' | 'storage' | 'vessels'>,
  entry: InventoryEquipmentCatalogEntry
): InventoryEquipmentCatalogUpdatePreview {
  const installed: InventoryCatalogInstalledReference[] = (['storage', 'vessel'] as const).flatMap(
    (kind) =>
      Object.values(kind === 'storage' ? state.storage : state.vessels).map((record) => ({
        item: { kind, id: record.id },
        name: record.name,
        typeVersionId: record.configuration.typeVersionId,
        recipeVersionId: record.configuration.recipe?.recipeVersionId ?? null,
      }))
  );
  const definitions = compareCatalogDefinitions(state, entry.definitions).map((comparison) => {
    const parsed = comparison.definition;
    return {
      ...comparison,
      installedReferences: installed.filter((reference) =>
        parsed.kind === 'define-physical-type'
          ? reference.typeVersionId === parsed.id
          : parsed.kind === 'define-equipment-recipe'
            ? reference.recipeVersionId === parsed.id
            : parsed.kind === 'record-temperature-claim'
              ? parsed.subject.kind === 'type-version'
                ? reference.typeVersionId === parsed.subject.versionId
                : parsed.subject.item.kind === reference.item.kind &&
                  parsed.subject.item.id === reference.item.id
              : [parsed.parent, parsed.child].some(
                  (subject) =>
                    subject.kind === 'installed' &&
                    subject.item.kind === reference.item.kind &&
                    subject.item.id === reference.item.id
                )
      ),
    };
  });
  const conflictCount = definitions.filter((row) => row.status === 'conflicting').length;
  const references = new Map(
    definitions.flatMap((row) =>
      row.installedReferences.map(
        (reference) => [`${reference.item.kind}:${reference.item.id}`, reference] as const
      )
    )
  );
  return structuredClone({
    revision: state.revision,
    entryId: entry.id,
    name: entry.name,
    description: entry.description,
    model: entry.model,
    sources: entry.sources,
    recipeVersionId: entry.recipeVersionId,
    canApply: conflictCount === 0,
    conflictCount,
    definitions,
    installedReferences: [...references.values()],
  });
}
