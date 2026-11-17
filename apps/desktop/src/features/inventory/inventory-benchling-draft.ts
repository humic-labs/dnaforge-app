import type {
  InventoryBenchlingCaptureChoices,
  InventoryBenchlingCapturedChoice,
  InventoryBenchlingFactChoice,
  InventoryBenchlingGridLayoutChoice,
  InventoryBenchlingPlacementBasis,
  InventoryBenchlingQuantityChoice,
  InventoryBenchlingRecord,
  InventoryBenchlingRecordDecision,
  InventoryBenchlingStoragePlacementChoice,
  InventoryBenchlingVesselPlacementChoice,
  InventoryBenchlingCaptureInspection,
  InventoryLayout,
  InventoryQuality,
} from '@waypoint/domain-services';

export interface CaptureFactDraft {
  mode: 'captured' | 'declared';
  reference: string;
  value: string;
  reason: string;
}
export interface CapturePlacementDraft {
  kind: '' | 'root' | 'unplaced' | 'source' | 'existing';
  parentSourceId: string;
  storageId: string;
  position: string;
  basis: string;
  reason: string;
  positionBasis: 'captured-exact' | 'declared-mapping';
  positionReason: string;
}
export interface CaptureRecordDraft {
  disposition: '' | 'skip' | 'evidence' | 'storage' | 'vessel';
  reason: string;
  name: CaptureFactDraft;
  plateType: CaptureFactDraft;
  layoutMode: 'schema' | 'declared';
  schema: string;
  height: string;
  width: string;
  layoutKind: InventoryLayout['kind'];
  positions: string;
  rows: string;
  columns: string;
  capacity: string;
  layoutReason: string;
  target: '' | 'movable' | 'fixed-well';
  placement: CapturePlacementDraft;
  contents: '' | 'empty' | 'unobserved' | 'unidentified' | 'identify';
  contentsReference: string;
  contentsReason: string;
  materialId: string;
  quality: InventoryQuality | '';
  qualityReason: string;
  quantity: '' | 'source-volume' | 'unknown';
  quantityField: 'quantity' | 'volume';
  quantityReference: string;
  quantityReason: string;
  uncapturedPositions: string;
  uncapturedReason: string;
}
export const captureRecordKey = (record: { kind: string; sourceId: string }) =>
  JSON.stringify([record.kind, record.sourceId]);
export const captureReference = (value: { responseId: string; pointer: string }) =>
  JSON.stringify([value.responseId, value.pointer]);
export const captureSchemaKey = captureRecordKey;
const factDraft = (): CaptureFactDraft => ({
  mode: 'captured',
  reference: '',
  value: '',
  reason: '',
});
export function emptyCaptureRecordDraft(): CaptureRecordDraft {
  return {
    disposition: '',
    reason: '',
    name: factDraft(),
    plateType: factDraft(),
    layoutMode: 'schema',
    schema: '',
    height: '',
    width: '',
    layoutKind: 'named',
    positions: '',
    rows: '',
    columns: '',
    capacity: '',
    layoutReason: '',
    target: '',
    placement: {
      kind: '',
      parentSourceId: '',
      storageId: '',
      position: '',
      basis: 'declared',
      reason: '',
      positionBasis: 'declared-mapping',
      positionReason: '',
    },
    contents: '',
    contentsReference: '',
    contentsReason: '',
    materialId: '',
    quality: '',
    qualityReason: '',
    quantity: '',
    quantityField: 'quantity',
    quantityReference: '',
    quantityReason: '',
    uncapturedPositions: '',
    uncapturedReason: '',
  };
}
function tuple(value: string): [string, string] {
  if (!value) return ['', ''];
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    parsed.some((item) => typeof item !== 'string')
  )
    throw new Error('Choose an exact captured observation.');
  return parsed as [string, string];
}
export function capturedChoice(reference: string, reason = ''): InventoryBenchlingCapturedChoice {
  const [responseId, pointer] = tuple(reference);
  return { kind: 'captured', responseId, pointer, reason: reason.trim() || null };
}
function fact<T extends string>(draft: CaptureFactDraft): InventoryBenchlingFactChoice<T> {
  return draft.mode === 'declared'
    ? { kind: 'declared', value: draft.value as T, reason: draft.reason.trim() }
    : capturedChoice(draft.reference, draft.reason);
}
const integer = (value: string) =>
  /^\d+$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : 0;
const positions = (value: string) =>
  value
    .split(/[,\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
function placement(
  draft: CapturePlacementDraft
): InventoryBenchlingStoragePlacementChoice | InventoryBenchlingVesselPlacementChoice {
  const basis: InventoryBenchlingPlacementBasis =
    draft.basis === 'declared'
      ? { kind: 'declared', reason: draft.reason.trim() }
      : draft.basis.startsWith('membership:')
        ? { ...capturedChoice(draft.basis.slice(11), draft.reason), kind: 'membership' }
        : capturedChoice(draft.basis.slice(9), draft.reason);
  const position = {
    value: draft.position,
    basis: draft.positionBasis,
    reason: draft.positionReason.trim() || null,
  };
  if (draft.kind === 'root' || draft.kind === 'unplaced') return { kind: draft.kind, basis };
  if (draft.kind === 'source')
    return { kind: 'source', parentSourceId: draft.parentSourceId, position, basis };
  if (draft.kind === 'existing')
    return {
      kind: 'existing',
      storageId: draft.storageId,
      position,
      basis,
      reason: draft.reason.trim(),
    };
  throw new Error('Choose a parent or explicitly declare root/unplaced.');
}
function grid(
  draft: CaptureRecordDraft,
  kind: 'box' | 'plate'
): InventoryBenchlingGridLayoutChoice {
  if (draft.layoutMode === 'declared')
    return {
      kind: 'declared',
      value: { rows: integer(draft.rows), columns: integer(draft.columns) },
      reason: draft.layoutReason.trim(),
    };
  const [schemaKind, sourceId] = tuple(draft.schema);
  return {
    kind: 'captured-schema',
    schema: {
      kind:
        schemaKind === 'plate-schema'
          ? 'plate-schema'
          : kind === 'plate'
            ? 'plate-schema'
            : 'box-schema',
      sourceId,
    },
    height: capturedChoice(draft.height, draft.layoutReason),
    width: capturedChoice(draft.width, draft.layoutReason),
  };
}
function quantity(draft: CaptureRecordDraft): InventoryBenchlingQuantityChoice {
  if (!draft.quantity) throw new Error('Choose a captured volume or explicitly unknown quantity.');
  return draft.quantity === 'unknown'
    ? { kind: 'unknown', reason: draft.quantityReason.trim() }
    : {
        kind: 'source-volume',
        sourceField: draft.quantityField,
        selection: capturedChoice(draft.quantityReference, draft.quantityReason),
      };
}
export function buildCaptureChoices(
  inspection: InventoryBenchlingCaptureInspection,
  drafts: Readonly<Record<string, CaptureRecordDraft>>,
  scopeReason: string,
  issueReasons: Readonly<Record<string, string>>
): InventoryBenchlingCaptureChoices {
  const records = inspection.records.map((record): InventoryBenchlingRecordDecision => {
    const draft = drafts[captureRecordKey(record)] ?? emptyCaptureRecordDraft();
    if (!draft.disposition)
      throw new Error(`Choose a disposition for ${record.kind} ${record.sourceId}.`);
    if (record.kind === 'box-schema' || record.kind === 'plate-schema')
      return {
        record: { kind: record.kind, sourceId: record.sourceId },
        disposition: 'evidence',
        reason: draft.reason.trim(),
      };
    if (draft.disposition === 'skip')
      return {
        record: { kind: record.kind, sourceId: record.sourceId },
        disposition: 'skip',
        reason: draft.reason.trim(),
      };
    if (record.kind !== 'container') {
      const localLayout: InventoryLayout =
        draft.layoutKind === 'named'
          ? { kind: 'named', slots: positions(draft.positions) }
          : draft.layoutKind === 'stack'
            ? { kind: 'stack', capacity: integer(draft.capacity), removal: 'top-only' }
            : {
                kind: draft.layoutKind,
                rows: integer(draft.rows),
                columns: integer(draft.columns),
              };
      const destination = placement(draft.placement);
      if (destination.kind === 'unplaced')
        throw new Error(`Choose a storage parent for ${record.sourceId}.`);
      return {
        record: { kind: record.kind, sourceId: record.sourceId },
        disposition: 'storage',
        name: fact(draft.name),
        definition:
          record.kind === 'location'
            ? {
                kind: 'location',
                layout: { kind: 'declared', value: localLayout, reason: draft.layoutReason.trim() },
              }
            : record.kind === 'box'
              ? { kind: 'box', layout: grid(draft, 'box') }
              : {
                  kind: 'plate',
                  plateType: fact<'well_plate' | 'matrix_plate'>(draft.plateType),
                  layout: grid(draft, 'plate'),
                },
        placement: destination,
      };
    }
    if (!draft.target)
      throw new Error(`Choose movable container or permanent well for ${record.sourceId}.`);
    const basis = placement(draft.placement);
    const target =
      draft.target === 'fixed-well'
        ? {
            kind: 'fixed-well' as const,
            plateSourceId: draft.placement.parentSourceId,
            position: {
              value: draft.placement.position,
              basis: draft.placement.positionBasis,
              reason: draft.placement.positionReason.trim() || null,
            },
            basis: basis.basis,
          }
        : (() => {
            if (basis.kind === 'root')
              throw new Error(
                'A movable container needs a placement or an explicit unplaced declaration.'
              );
            return { kind: 'movable' as const, name: fact(draft.name), placement: basis };
          })();
    if (!draft.contents) throw new Error(`Choose the contents status for ${record.sourceId}.`);
    let contents: Extract<InventoryBenchlingRecordDecision, { disposition: 'vessel' }>['contents'];
    if (draft.contents === 'unobserved')
      contents = { kind: 'unobserved', reason: draft.contentsReason.trim() };
    else if (draft.contents === 'unidentified')
      contents = {
        kind: 'unidentified',
        selection: capturedChoice(draft.contentsReference, draft.contentsReason),
        reason: draft.contentsReason.trim(),
      };
    else if (draft.contents === 'empty') {
      const amount = quantity(draft);
      if (amount.kind !== 'source-volume')
        throw new Error(
          `Empty ${record.sourceId} needs a captured zero volume, not unknown quantity.`
        );
      contents = {
        kind: 'empty',
        selection: capturedChoice(draft.contentsReference, draft.contentsReason),
        quantity: amount,
        reason: draft.contentsReason.trim(),
      };
    } else {
      if (!draft.quality) throw new Error(`Choose stock quality for ${record.sourceId}.`);
      contents = {
        kind: 'identify',
        selection: capturedChoice(draft.contentsReference, draft.contentsReason),
        materialId: draft.materialId,
        quantity: quantity(draft),
        quality: { value: draft.quality, reason: draft.qualityReason.trim() },
        reason: draft.contentsReason.trim(),
      };
    }
    return {
      record: { kind: 'container', sourceId: record.sourceId },
      disposition: 'vessel',
      target,
      contents,
    };
  });
  return {
    scopeAcceptance: { kind: 'selected-records', reason: scopeReason.trim() },
    records,
    sourceIssueDispositions: inspection.issues
      .filter((issue) => issue.severity === 'needs-resolution')
      .map((issue) => ({
        code: issue.code,
        responseId: issue.responseId,
        bodyPointer: issue.bodyPointer,
        reason:
          issueReasons[JSON.stringify([issue.code, issue.responseId, issue.bodyPointer])] ?? '',
      })),
    uncapturedPositions: inspection.records.flatMap((record) => {
      const draft = drafts[captureRecordKey(record)];
      return draft?.disposition === 'storage' && positions(draft.uncapturedPositions).length
        ? [
            {
              storageSourceId: record.sourceId,
              positions: positions(draft.uncapturedPositions),
              kind: 'unavailable' as const,
              reason: draft.uncapturedReason.trim(),
            },
          ]
        : [];
    }),
  };
}
export function copyUniqueCaptureFacts(
  record: InventoryBenchlingRecord,
  inspection: InventoryBenchlingCaptureInspection,
  draft: CaptureRecordDraft
): CaptureRecordDraft {
  const next = structuredClone(draft);
  const unique = (name: string) => {
    const found = record.fields[name]?.observations.filter((value) => value.kind === 'present');
    return found?.length === 1 ? found[0] : null;
  };
  const name = unique('name');
  if (name) next.name = { ...next.name, mode: 'captured', reference: captureReference(name) };
  const type = unique('type');
  if (type)
    next.plateType = { ...next.plateType, mode: 'captured', reference: captureReference(type) };
  const contents = unique('contents');
  if (contents) next.contentsReference = captureReference(contents);
  const amount = unique(next.quantityField);
  if (amount) next.quantityReference = captureReference(amount);
  const schema = unique('schema');
  if (schema?.kind === 'present') {
    const value: unknown = JSON.parse(schema.jsonText);
    const sourceId =
      value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
        ? value.id
        : null;
    const matching = inspection.records.find(
      (item) =>
        item.sourceId === sourceId &&
        item.kind === (record.kind === 'plate' ? 'plate-schema' : 'box-schema')
    );
    if (matching) {
      next.schema = captureSchemaKey(matching);
      const height = matching.fields.height?.observations.filter(
        (value) => value.kind === 'present'
      );
      const width = matching.fields.width?.observations.filter((value) => value.kind === 'present');
      if (height?.length === 1) next.height = captureReference(height[0]);
      if (width?.length === 1) next.width = captureReference(width[0]);
    }
  }
  const membership = inspection.placements.filter((item) => item.containerId === record.sourceId);
  if (membership.length === 1) {
    const selected = membership[0];
    next.placement.kind = 'source';
    next.placement.parentSourceId =
      selected.kind === 'plate-well' ? selected.plateId : selected.boxId;
    next.placement.basis = `membership:${captureReference(selected)}`;
    if (selected.kind === 'plate-well') {
      next.placement.position = selected.position;
      next.placement.positionBasis = 'captured-exact';
    } else if (selected.gridPosition.kind === 'present') {
      const value: unknown = JSON.parse(selected.gridPosition.jsonText);
      if (typeof value === 'string') {
        next.placement.position = value;
        next.placement.positionBasis = 'captured-exact';
      }
    }
  } else {
    const parent = unique('parentStorageId');
    if (parent?.kind === 'present') {
      const value: unknown = JSON.parse(parent.jsonText);
      if (typeof value === 'string') {
        next.placement.kind = 'source';
        next.placement.parentSourceId = value;
        next.placement.basis = `captured:${captureReference(parent)}`;
      }
    }
  }
  return next;
}

export function captureDraftsFromChoices(
  choices: InventoryBenchlingCaptureChoices
): Record<string, CaptureRecordDraft> {
  const fact = <T extends string>(choice: InventoryBenchlingFactChoice<T>): CaptureFactDraft =>
    choice.kind === 'captured'
      ? {
          mode: 'captured',
          reference: captureReference(choice),
          value: '',
          reason: choice.reason ?? '',
        }
      : { mode: 'declared', reference: '', value: choice.value, reason: choice.reason };
  const placement = (
    choice: InventoryBenchlingStoragePlacementChoice | InventoryBenchlingVesselPlacementChoice
  ): CapturePlacementDraft => {
    const basis =
      choice.basis.kind === 'declared'
        ? 'declared'
        : `${choice.basis.kind}:${captureReference(choice.basis)}`;
    const located = choice.kind === 'source' || choice.kind === 'existing';
    return {
      kind: choice.kind,
      parentSourceId: choice.kind === 'source' ? choice.parentSourceId : '',
      storageId: choice.kind === 'existing' ? choice.storageId : '',
      position: located ? choice.position.value : '',
      basis,
      reason: choice.basis.reason ?? '',
      positionBasis: located ? choice.position.basis : 'declared-mapping',
      positionReason: located ? (choice.position.reason ?? '') : '',
    };
  };
  const records: Record<string, CaptureRecordDraft> = {};
  for (const choice of choices.records) {
    const draft = emptyCaptureRecordDraft();
    draft.disposition = choice.disposition;
    if (choice.disposition === 'skip' || choice.disposition === 'evidence')
      draft.reason = choice.reason;
    if (choice.disposition === 'storage') {
      draft.name = fact(choice.name);
      draft.placement = placement(choice.placement);
      if (choice.definition.kind === 'plate') draft.plateType = fact(choice.definition.plateType);
      const layout = choice.definition.layout;
      if (layout.kind === 'captured-schema') {
        draft.layoutMode = 'schema';
        draft.schema = captureRecordKey(layout.schema);
        draft.height = captureReference(layout.height);
        draft.width = captureReference(layout.width);
        draft.layoutReason = [
          ...new Set(
            [layout.height.reason, layout.width.reason].filter(
              (value): value is string => value !== null
            )
          ),
        ].join('; ');
      } else {
        draft.layoutMode = 'declared';
        draft.layoutReason = layout.reason;
        const value = layout.value;
        if ('kind' in value) {
          draft.layoutKind = value.kind;
          if (value.kind === 'named') draft.positions = value.slots.join(', ');
          if (value.kind === 'stack') draft.capacity = String(value.capacity);
        }
        if ('rows' in value) {
          draft.rows = String(value.rows);
          draft.columns = String(value.columns);
        }
      }
      const policy = choices.uncapturedPositions.find(
        (item) => item.storageSourceId === choice.record.sourceId
      );
      if (policy) {
        draft.uncapturedPositions = policy.positions.join(', ');
        draft.uncapturedReason = policy.reason;
      }
    }
    if (choice.disposition === 'vessel') {
      draft.target = choice.target.kind;
      if (choice.target.kind === 'movable') {
        draft.name = fact(choice.target.name);
        draft.placement = placement(choice.target.placement);
      } else
        draft.placement = placement({
          kind: 'source',
          parentSourceId: choice.target.plateSourceId,
          position: choice.target.position,
          basis: choice.target.basis,
        });
      draft.contents = choice.contents.kind;
      draft.contentsReason = choice.contents.reason;
      if (choice.contents.kind !== 'unobserved')
        draft.contentsReference = captureReference(choice.contents.selection);
      if (choice.contents.kind === 'identify') {
        draft.materialId = choice.contents.materialId;
        draft.quality = choice.contents.quality.value;
        draft.qualityReason = choice.contents.quality.reason;
      }
      if (choice.contents.kind === 'identify' || choice.contents.kind === 'empty') {
        const quantity = choice.contents.quantity;
        draft.quantity = quantity.kind;
        draft.quantityReason =
          quantity.kind === 'unknown' ? quantity.reason : (quantity.selection.reason ?? '');
        if (quantity.kind === 'source-volume') {
          draft.quantityField = quantity.sourceField;
          draft.quantityReference = captureReference(quantity.selection);
        }
      }
    }
    records[captureRecordKey(choice.record)] = draft;
  }
  return records;
}
