import { inspectInventoryBenchlingCapture } from '../inventory-benchling-source';
import type {
  InventoryBenchlingCaptureChoices,
  InventoryBenchlingCapturedChoice,
  InventoryBenchlingRecordDecision,
} from '../inventory-benchling-application-types';
const maxBytes = 17 * 1024 * 1024;
const reason = 'Explicit synthetic capture interpretation';
export function benchlingCaptureChoices(sourceText: string): InventoryBenchlingCaptureChoices {
  const inspection = inspectInventoryBenchlingCapture(sourceText, maxBytes);
  const selected = (
    id: string,
    field: string,
    responseId?: string
  ): InventoryBenchlingCapturedChoice => {
    const record = inspection.records.find((record) => record.sourceId === id)!;
    const item = record.fields[field].observations.find(
      (item) => item.kind !== 'omitted' && (!responseId || item.responseId === responseId)
    )!;
    return { kind: 'captured', responseId: item.responseId, pointer: item.pointer, reason };
  };
  const declared = <T>(value: T) => ({ kind: 'declared' as const, value, reason });
  const position = (value: string, exact = false) => ({
    value,
    basis: exact ? ('captured-exact' as const) : ('declared-mapping' as const),
    reason,
  });
  const membership = (id: string) => {
    const item = inspection.placements.find((item) => item.containerId === id)!;
    return {
      kind: 'membership' as const,
      responseId: item.responseId,
      pointer: item.pointer,
      reason,
    };
  };
  const sourcePlacement = (id: string, parentSourceId: string, slot: string) => ({
    kind: 'source' as const,
    parentSourceId,
    position: position(slot),
    basis: selected(id, 'parentStorageId'),
  });
  const grid = (id: string, schemaId: string, kind: 'box-schema' | 'plate-schema') => ({
    kind: 'captured-schema' as const,
    schema: { kind, sourceId: schemaId },
    height: selected(schemaId, 'height'),
    width: selected(schemaId, 'width'),
  });
  const volume = (id: string, responseId?: string) => ({
    kind: 'source-volume' as const,
    sourceField: 'quantity' as const,
    selection: selected(id, 'quantity', responseId),
  });
  const records: InventoryBenchlingRecordDecision[] = [];
  for (const record of inspection.records) {
    const id = record.sourceId;
    if (record.kind.endsWith('-schema')) {
      records.push({
        record: { kind: record.kind as 'box-schema' | 'plate-schema', sourceId: id },
        disposition: 'evidence',
        reason,
      });
      continue;
    }
    if (record.kind === 'location') {
      records.push({
        record: { kind: 'location', sourceId: id },
        disposition: 'storage',
        name: selected(id, 'name'),
        definition: {
          kind: 'location',
          layout: declared({
            kind: 'named',
            slots: id === 'loc_freezer' ? ['Shelf'] : ['Box', 'Fixed', 'Matrix'],
          }),
        },
        placement:
          id === 'loc_freezer'
            ? { kind: 'root', basis: selected(id, 'parentStorageId') }
            : sourcePlacement(id, 'loc_freezer', 'Shelf'),
      });
      continue;
    }
    if (record.kind === 'box' || record.kind === 'plate') {
      const definition =
        record.kind === 'box'
          ? { kind: 'box' as const, layout: grid(id, 'boxsch_1', 'box-schema') }
          : {
              kind: 'plate' as const,
              plateType: selected(id, 'type'),
              layout: grid(
                id,
                id === 'plt_fixed' ? 'pltsch_fixed' : 'pltsch_matrix',
                'plate-schema'
              ),
            };
      records.push({
        record: { kind: record.kind, sourceId: id },
        disposition: 'storage',
        name: selected(id, 'name'),
        definition,
        placement: sourcePlacement(
          id,
          'loc_shelf',
          record.kind === 'box' ? 'Box' : id === 'plt_fixed' ? 'Fixed' : 'Matrix'
        ),
      });
      continue;
    }
    const claim = inspection.placements.find((item) => item.containerId === id);
    const vesselTarget = id.startsWith('con_well')
      ? {
          kind: 'fixed-well' as const,
          plateSourceId: 'plt_fixed',
          position: position(claim!.kind === 'plate-well' ? claim!.position : '', true),
          basis: membership(id),
        }
      : {
          kind: 'movable' as const,
          name: selected(id, 'name'),
          placement: claim
            ? {
                kind: 'source' as const,
                parentSourceId: claim.kind === 'plate-well' ? claim.plateId : claim.boxId,
                position: position(
                  claim.kind === 'plate-well'
                    ? claim.position
                    : JSON.parse(
                        claim.gridPosition.kind === 'present' ? claim.gridPosition.jsonText : 'null'
                      ),
                  true
                ),
                basis: membership(id),
              }
            : { kind: 'unplaced' as const, basis: { kind: 'declared' as const, reason } },
        };
    const contents =
      id === 'con_missing'
        ? { kind: 'unobserved' as const, reason }
        : id === 'con_empty' || id === 'con_well_empty'
          ? {
              kind: 'empty' as const,
              selection: selected(id, 'contents'),
              quantity: volume(id),
              reason,
            }
          : id === 'con_multiple' || id === 'con_count'
            ? { kind: 'unidentified' as const, selection: selected(id, 'contents'), reason }
            : {
                kind: 'identify' as const,
                selection: selected(id, 'contents'),
                materialId: id === 'con_matrix_tube' ? 'material-b' : 'material-a',
                quantity:
                  id === 'con_matrix_tube'
                    ? { kind: 'unknown' as const, reason }
                    : volume(id, id === 'con_filled' ? 'box-page-1' : undefined),
                quality: {
                  value: id === 'con_filled' ? ('quarantined' as const) : ('usable' as const),
                  reason,
                },
                reason,
              };
    records.push({
      record: { kind: 'container', sourceId: id },
      disposition: 'vessel',
      target: vesselTarget,
      contents,
    });
  }
  return {
    scopeAcceptance: { kind: 'selected-records', reason },
    records,
    sourceIssueDispositions: inspection.issues.map(({ code, responseId, bodyPointer }) => ({
      code,
      responseId,
      bodyPointer,
      reason,
    })),
    uncapturedPositions: [
      { storageSourceId: 'plt_matrix', kind: 'unavailable', positions: ['A2', 'B1', 'B2'], reason },
    ],
  };
}
