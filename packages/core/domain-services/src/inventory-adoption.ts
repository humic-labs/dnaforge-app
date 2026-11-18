import type {
  InventoryAdoptionSource,
  InventoryCatalogSelectionState,
  InventoryComposition,
  InventoryCustody,
  InventoryExecutionContext,
  InventoryLot,
  InventoryLotOrigin,
  InventoryPhysicalConfiguration,
  InventoryRecordedAuthority,
  InventoryRecordedPrincipal,
  InventorySourceIdentity,
  InventoryState,
  InventoryTransition,
} from './inventory-types';
import {
  parseInventoryAdoptionSource,
  parseInventoryExecutionContext,
  parseInventoryState,
} from './inventory-validation';

export interface InventoryScientificReference {
  readonly materialId: string;
  readonly pointers: readonly string[];
}
export interface InventoryAdoptionOptions {
  readonly source: InventoryAdoptionSource;
  readonly materialBindings: Readonly<Record<string, string>>;
}

const pointerKey = (value: string): string => value.replaceAll('~', '~0').replaceAll('/', '~1');
const order = (first: string, second: string): number =>
  first < second ? -1 : first > second ? 1 : 0;
type ResolveMaterial = (materialId: string, pointer: string) => string;

function mapRecords<T>(
  rows: Readonly<Record<string, T>>,
  map: (row: T, id: string) => T
): Readonly<Record<string, T>> {
  let result: Record<string, T> | undefined;
  for (const [id, row] of Object.entries(rows)) {
    const mapped = map(row, id);
    if (mapped !== row) {
      const updated: Record<string, T> = result ?? Object.assign(Object.create(null), rows);
      updated[id] = mapped;
      result = updated;
    }
  }
  return result ?? rows;
}
function mapComposition(
  value: InventoryComposition,
  pointer: string,
  resolve: ResolveMaterial
): InventoryComposition {
  if (value.kind === 'unknown') return value;
  let changed = false;
  const analytes = Object.create(null) as Record<string, (typeof value.analytes)[string]>;
  for (const [id, concentration] of Object.entries(value.analytes)) {
    const mapped = resolve(id, `${pointer}/analytes/${pointerKey(id)}`);
    changed ||= mapped !== id;
    analytes[mapped] = concentration;
  }
  return changed ? { ...value, analytes } : value;
}
function mapIdentity<T extends Pick<InventorySourceIdentity, 'materialId' | 'composition'>>(
  value: T,
  pointer: string,
  resolve: ResolveMaterial
): T {
  const materialId = resolve(value.materialId, `${pointer}/materialId`);
  const composition = mapComposition(value.composition, `${pointer}/composition`, resolve);
  return materialId === value.materialId && composition === value.composition
    ? value
    : { ...value, materialId, composition };
}
function mapOrigin(
  value: InventoryLotOrigin,
  pointer: string,
  resolve: ResolveMaterial
): InventoryLotOrigin {
  switch (value.kind) {
    case 'received':
      return value;
    case 'prepared':
      return {
        ...value,
        inputs: value.inputs.map((input, index) =>
          mapIdentity(input, `${pointer}/inputs/${index}`, resolve)
        ),
      };
    case 'pooled':
      return {
        ...value,
        inputs: value.inputs.map((input, index) =>
          mapIdentity(input, `${pointer}/inputs/${index}`, resolve)
        ),
      };
    case 'diluted':
      return {
        ...value,
        sample: mapIdentity(value.sample, `${pointer}/sample`, resolve),
        diluent: mapIdentity(value.diluent, `${pointer}/diluent`, resolve),
      };
  }
}
function mapScientificReferences(state: InventoryState, resolve: ResolveMaterial): InventoryState {
  return {
    ...state,
    scientificWorks: mapRecords(state.scientificWorks, (work, id) => ({
      ...work,
      effects: {
        source: {
          ...work.effects.source,
          before: mapIdentity(
            work.effects.source.before,
            `/scientificWorks/${pointerKey(id)}/effects/source/before`,
            resolve
          ),
          after: mapIdentity(
            work.effects.source.after,
            `/scientificWorks/${pointerKey(id)}/effects/source/after`,
            resolve
          ),
        },
        destination: {
          ...work.effects.destination,
          after: mapIdentity(
            work.effects.destination.after,
            `/scientificWorks/${pointerKey(id)}/effects/destination/after`,
            resolve
          ),
        },
      },
    })),
    expectedDeliveries: mapRecords(state.expectedDeliveries, (row, id) => ({
      ...row,
      expectation: {
        ...row.expectation,
        materialId: resolve(
          row.expectation.materialId,
          `/expectedDeliveries/${pointerKey(id)}/expectation/materialId`
        ),
      },
    })),
    reorderRules: mapRecords(state.reorderRules, (row, id) => ({
      ...row,
      materialId: resolve(row.materialId, `/reorderRules/${pointerKey(id)}/materialId`),
    })),
    arrivals: mapRecords(state.arrivals, (arrival, id) => ({
      ...arrival,
      components: arrival.components.map((component, index) => ({
        ...component,
        choice:
          component.choice.kind === 'identified'
            ? {
                ...component.choice,
                materialId: resolve(
                  component.choice.materialId,
                  `/arrivals/${pointerKey(id)}/components/${index}/choice/materialId`
                ),
              }
            : component.choice,
      })),
    })),
    tableBindings: mapRecords(state.tableBindings, (binding, id) => ({
      ...binding,
      materialId: resolve(binding.materialId, `/tableBindings/${pointerKey(id)}/materialId`),
    })),
    stocks: mapRecords(state.stocks, (stock, id) =>
      mapIdentity(stock, `/stocks/${pointerKey(id)}`, resolve)
    ),
    lots: mapRecords(
      state.lots,
      (lot, id): InventoryLot => ({
        ...lot,
        materialId: resolve(lot.materialId, `/lots/${pointerKey(id)}/materialId`),
        origin: mapOrigin(lot.origin, `/lots/${pointerKey(id)}/origin`, resolve),
      })
    ),
  };
}

export function inventoryScientificReferences(
  state: InventoryState
): readonly InventoryScientificReference[] {
  const pointers = new Map<string, string[]>();
  mapScientificReferences(state, (materialId, pointer) => {
    const list = pointers.get(materialId) ?? [];
    list.push(pointer);
    pointers.set(materialId, list);
    return materialId;
  });
  return [...pointers]
    .sort(([first], [second]) => order(first, second))
    .map(([materialId, values]) => ({
      materialId,
      pointers: values.sort(order),
    }));
}
export function inventoryScientificMaterialIds(state: InventoryState): readonly string[] {
  return inventoryScientificReferences(state).map((reference) => reference.materialId);
}

function mapAttribution(state: InventoryState, source: InventoryAdoptionSource): InventoryState {
  const principal = (value: InventoryRecordedPrincipal): InventoryRecordedPrincipal =>
    value.kind === 'imported'
      ? value
      : { kind: 'imported', source: { ...source }, principal: { ...value } };
  const authority = (value: InventoryRecordedAuthority): InventoryRecordedAuthority =>
    value.kind === 'imported'
      ? value
      : { kind: 'imported', source: { ...source }, authority: { ...value } };
  const custody = (value: InventoryCustody): InventoryCustody => {
    if (value.kind === 'available') return value;
    if (value.kind === 'missing')
      return {
        ...value,
        holder: value.holder ? principal(value.holder) : null,
        reportedBy: principal(value.reportedBy),
      };
    return { ...value, holder: principal(value.holder) };
  };
  const configuration = (
    value: InventoryPhysicalConfiguration
  ): InventoryPhysicalConfiguration => ({
    ...value,
    geometryOverride: value.geometryOverride
      ? { ...value.geometryOverride, by: principal(value.geometryOverride.by) }
      : null,
  });
  const selection = (value: InventoryCatalogSelectionState): InventoryCatalogSelectionState =>
    value.kind === 'available' ? value : { ...value, by: principal(value.by) };
  return {
    ...state,
    scientificCitations: mapRecords(state.scientificCitations, (citation) => ({
      ...citation,
      by: principal(citation.by),
    })),
    scientificCitationWithdrawals: mapRecords(
      state.scientificCitationWithdrawals,
      (withdrawal) => ({
        ...withdrawal,
        by: principal(withdrawal.by),
      })
    ),
    scientificWorks: mapRecords(state.scientificWorks, (work) => ({
      ...work,
      by: principal(work.by),
    })),
    expectedDeliveries: mapRecords(state.expectedDeliveries, (row) => ({
      ...row,
      by: principal(row.by),
      lifecycle:
        row.lifecycle.kind === 'open'
          ? row.lifecycle
          : { ...row.lifecycle, by: principal(row.lifecycle.by) },
    })),
    arrivalAllocations: mapRecords(state.arrivalAllocations, (row) => ({
      ...row,
      by: principal(row.by),
      lifecycle:
        row.lifecycle.kind === 'active'
          ? row.lifecycle
          : { ...row.lifecycle, by: principal(row.lifecycle.by) },
    })),
    reorderRules: mapRecords(state.reorderRules, (row) => ({
      ...row,
      by: principal(row.by),
      lifecycle:
        row.lifecycle.kind === 'active'
          ? row.lifecycle
          : { ...row.lifecycle, by: principal(row.lifecycle.by) },
    })),
    arrivals: mapRecords(state.arrivals, (row) => ({ ...row, by: principal(row.by) })),
    openingObservations: mapRecords(state.openingObservations, (row) => ({
      ...row,
      by: principal(row.by),
    })),
    validityFacts: mapRecords(state.validityFacts, (row) => ({ ...row, by: principal(row.by) })),
    lots: mapRecords(state.lots, (row) => ({
      ...row,
      controls:
        row.controls.kind === 'legacy-untracked'
          ? row.controls
          : {
              ...row.controls,
              assessment: { ...row.controls.assessment, by: principal(row.controls.assessment.by) },
            },
    })),
    lotRecalls: mapRecords(state.lotRecalls, (row) => ({
      ...row,
      by: principal(row.by),
      lifecycle:
        row.lifecycle.kind === 'active'
          ? row.lifecycle
          : { ...row.lifecycle, by: principal(row.lifecycle.by) },
    })),
    tableBindings: mapRecords(state.tableBindings, (binding) => ({
      ...binding,
      sourceRevisions: binding.sourceRevisions.map((revision) => ({
        ...revision,
        by: principal(revision.by),
      })),
    })),
    observations: mapRecords(state.observations, (row) => ({
      ...row,
      by: principal(row.by),
      application:
        row.application.kind === 'applied'
          ? { ...row.application, by: principal(row.application.by) }
          : row.application,
    })),
    storage: mapRecords(state.storage, (row) => ({
      ...row,
      custody: custody(row.custody),
      configuration: configuration(row.configuration),
    })),
    vessels: mapRecords(state.vessels, (row) => {
      const contentsKnowledge =
        row.contentsKnowledge.kind === 'recorded'
          ? row.contentsKnowledge
          : { ...row.contentsKnowledge, by: principal(row.contentsKnowledge.by) };
      return row.kind === 'fixed-well'
        ? { ...row, contentsKnowledge, configuration: configuration(row.configuration) }
        : {
            ...row,
            contentsKnowledge,
            custody: custody(row.custody),
            configuration: configuration(row.configuration),
          };
    }),
    reservations: mapRecords(state.reservations, (row) => ({
      ...row,
      holder: principal(row.holder),
      lifecycle:
        row.lifecycle.kind === 'cancelled'
          ? { ...row.lifecycle, authority: authority(row.lifecycle.authority) }
          : row.lifecycle,
    })),
    itemCodes: mapRecords(state.itemCodes, (row) => ({
      ...row,
      assignedBy: principal(row.assignedBy),
      lifecycle:
        row.lifecycle.kind === 'retired'
          ? { ...row.lifecycle, by: principal(row.lifecycle.by) }
          : row.lifecycle,
    })),
    typeVersions: mapRecords(state.typeVersions, (row) => ({
      ...row,
      publishedBy: principal(row.publishedBy),
      selection: selection(row.selection),
    })),
    recipeVersions: mapRecords(state.recipeVersions, (row) => ({
      ...row,
      publishedBy: principal(row.publishedBy),
      selection: selection(row.selection),
    })),
    fitEvidence: mapRecords(state.fitEvidence, (row) => ({ ...row, by: principal(row.by) })),
    temperatureClaims: mapRecords(state.temperatureClaims, (row) => ({
      ...row,
      by: principal(row.by),
      lifecycle:
        row.lifecycle.kind === 'withdrawn'
          ? { ...row.lifecycle, by: principal(row.lifecycle.by) }
          : row.lifecycle,
    })),
    equipmentSetpoints: mapRecords(state.equipmentSetpoints, (row) => ({
      ...row,
      by: principal(row.by),
    })),
    storageRequirements: mapRecords(state.storageRequirements, (row) => ({
      ...row,
      by: principal(row.by),
    })),
    thermalContexts: mapRecords(state.thermalContexts, (row) => ({
      ...row,
      by: principal(row.by),
    })),
  };
}

export function adoptInventoryState(
  target: InventoryState | null,
  sourceState: InventoryState,
  options: InventoryAdoptionOptions,
  context: InventoryExecutionContext
): InventoryTransition {
  if (target !== null)
    return {
      ok: false,
      code: 'IMPORT_TARGET_PRESENT',
      message: 'Archive adoption requires an absent destination inventory.',
    };
  let source: InventoryAdoptionSource;
  let state: InventoryState;
  try {
    source = parseInventoryAdoptionSource(options.source);
    context = parseInventoryExecutionContext(context);
    state = parseInventoryState(sourceState);
    if (state.revision !== source.revision)
      return {
        ok: false,
        code: 'IMPORT_SOURCE_INVALID',
        message: 'The archive source revision must match its captured inventory.',
      };
  } catch (error) {
    return {
      ok: false,
      code: 'IMPORT_SOURCE_INVALID',
      message: error instanceof Error ? error.message : 'Invalid archive adoption source.',
    };
  }
  if (state.lastRecordedAt > context.at)
    return {
      ok: false,
      code: 'IMPORT_SOURCE_CLOCK_FUTURE',
      message: 'The archive recorded clock is after native acceptance time.',
    };
  const required = new Set(inventoryScientificMaterialIds(state));
  const supplied = Object.keys(options.materialBindings);
  for (const id of required)
    if (
      !Object.hasOwn(options.materialBindings, id) ||
      typeof options.materialBindings[id] !== 'string' ||
      !options.materialBindings[id].length
    )
      return {
        ok: false,
        code: 'IMPORT_BINDING_MISSING',
        message: `Map the source scientific material ${id} explicitly.`,
      };
  for (const id of supplied)
    if (!required.has(id))
      return {
        ok: false,
        code: 'IMPORT_BINDING_UNUSED',
        message: `The source inventory does not reference scientific material ${id}.`,
      };
  if (new Set(supplied.map((id) => options.materialBindings[id])).size !== supplied.length)
    return {
      ok: false,
      code: 'IMPORT_BINDING_COLLISION',
      message: 'Distinct source scientific materials require distinct destination bindings.',
    };
  state = mapAttribution(
    mapScientificReferences(state, (id) => options.materialBindings[id]),
    source
  );
  try {
    return {
      ok: true,
      state: parseInventoryState({
        ...state,
        revision: 1,
        lastRecordedAt: context.at,
        origin: { kind: 'archive-adoption', source, at: context.at, by: { ...context.principal } },
      }),
    };
  } catch (error) {
    return {
      ok: false,
      code: 'IMPORT_SOURCE_INVALID',
      message: error instanceof Error ? error.message : 'Invalid adopted inventory facts.',
    };
  }
}
