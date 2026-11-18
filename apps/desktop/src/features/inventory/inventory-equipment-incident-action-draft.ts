import { z } from 'zod';
import {
  parseInventoryEquipmentIncidentActionChoices,
  type InventoryEquipmentIncidentAction,
  type InventoryEquipmentIncidentPin,
  type InventoryEquipmentIncidentFactPin,
  type InventoryEquipmentIncidentReviewRootPin,
  type InventoryEquipmentIncidentReviewDisposition,
  type InventoryPhysicalItem,
  type InventoryCustodyDestination,
} from '@waypoint/domain-services';

export type EquipmentIncidentFollowUpDraft = { incident: InventoryEquipmentIncidentPin } & (
  | {
      kind: 'manual-temperature';
      readingKind: 'measured' | 'withdrawn';
      temperature: string;
      observedTime: string;
      pointLabel: string;
      supersedes: InventoryEquipmentIncidentFactPin | null;
    }
  | {
      kind: 'completed-relocation';
      moves: readonly {
        item: InventoryPhysicalItem | null;
        destination: InventoryCustodyDestination | null;
      }[];
      corrects: InventoryEquipmentIncidentFactPin | null;
    }
  | {
      kind: 'impact-review';
      subjects: readonly {
        root: InventoryEquipmentIncidentReviewRootPin;
        supersedes: InventoryEquipmentIncidentFactPin | null;
      }[];
      disposition: InventoryEquipmentIncidentReviewDisposition | '';
      basis: string;
    }
  | { kind: 'resolve'; resolution: 'reported-resolved' | 'reported-in-error' | '' }
);

const pin = z
  .object({
    incidentId: z.string().min(1),
    intentSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const fact = z
  .object({ factId: z.string().min(1), intentSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/) })
  .strict();
const followUpDraftSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('manual-temperature'),
      incident: pin,
      readingKind: z.enum(['measured', 'withdrawn']),
      temperature: z.string(),
      observedTime: z.string(),
      pointLabel: z.string(),
      supersedes: fact.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('completed-relocation'),
      incident: pin,
      moves: z
        .array(
          z
            .object({
              item: z
                .object({ kind: z.enum(['storage', 'vessel']), id: z.string().min(1) })
                .strict()
                .nullable(),
              destination: z
                .discriminatedUnion('kind', [
                  z.object({ kind: z.literal('root') }).strict(),
                  z.object({ kind: z.literal('unplaced') }).strict(),
                  z
                    .object({
                      kind: z.literal('located'),
                      storageId: z.string().min(1),
                      slotId: z.string(),
                    })
                    .strict(),
                  z.object({ kind: z.literal('stack-top'), stackId: z.string().min(1) }).strict(),
                ])
                .nullable(),
            })
            .strict()
        )
        .min(1)
        .max(256),
      corrects: fact.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('impact-review'),
      incident: pin,
      subjects: z
        .array(
          z
            .object({
              root: z
                .object({
                  rootId: z.string().min(1),
                  intentSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
                })
                .strict(),
              supersedes: fact.nullable(),
            })
            .strict()
        )
        .max(1000),
      disposition: z.enum(['', 'keep-incident-restriction', 'remove-incident-restriction']),
      basis: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('resolve'),
      incident: pin,
      resolution: z.enum(['', 'reported-resolved', 'reported-in-error']),
    })
    .strict(),
]);
export function parseEquipmentIncidentFollowUpDraft(
  value: unknown
): EquipmentIncidentFollowUpDraft {
  return followUpDraftSchema.parse(value) as EquipmentIncidentFollowUpDraft;
}

export function equipmentIncidentTime(value: string): number {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw Error('Enter a valid UTC time including seconds and milliseconds.');
  return Date.parse(value);
}

export function equipmentIncidentFollowUpAction(
  draft: EquipmentIncidentFollowUpDraft,
  reason: string
): Exclude<InventoryEquipmentIncidentAction, { kind: 'report' }> {
  const common = { incident: draft.incident, reason: reason.trim() };
  let action: Exclude<InventoryEquipmentIncidentAction, { kind: 'report' }>;
  switch (draft.kind) {
    case 'manual-temperature':
      action = {
        ...common,
        kind: draft.kind,
        supersedes: draft.supersedes,
        reading:
          draft.readingKind === 'withdrawn'
            ? { kind: 'withdrawn' }
            : {
                kind: 'measured',
                temperature: { value: draft.temperature, unit: 'C' },
                observedAt: equipmentIncidentTime(draft.observedTime),
                pointLabel: draft.pointLabel.trim(),
              },
      };
      break;
    case 'completed-relocation':
      action = {
        ...common,
        kind: draft.kind,
        corrects: draft.corrects,
        moves: draft.moves.map((move) => {
          if (!move.item || !move.destination)
            throw Error('Choose each whole holder and its completed destination.');
          return { item: move.item, destination: move.destination };
        }),
      };
      break;
    case 'impact-review':
      if (!draft.disposition)
        throw Error('Choose whether this incident restriction is kept or removed.');
      action = {
        ...common,
        kind: draft.kind,
        subjects: draft.subjects,
        disposition: draft.disposition,
        basis: draft.basis.trim(),
      };
      break;
    case 'resolve':
      if (!draft.resolution) throw Error('Choose the reported resolution.');
      action = { ...common, kind: draft.kind, resolution: draft.resolution };
  }
  return parseInventoryEquipmentIncidentActionChoices({
    identity: { namespace: 'draft', actionId: 'draft' },
    action,
  }).action as typeof action;
}

export function equipmentIncidentFollowUpDraftKey(draft: EquipmentIncidentFollowUpDraft) {
  return JSON.stringify([
    draft.incident,
    draft.kind,
    draft.kind === 'manual-temperature'
      ? [draft.readingKind, draft.supersedes]
      : draft.kind === 'completed-relocation'
        ? draft.corrects
        : draft.kind === 'impact-review'
          ? draft.subjects
          : null,
  ]);
}

export function equipmentIncidentDraftLabel(kind: InventoryEquipmentIncidentAction['kind']) {
  return {
    report: 'Report equipment outage',
    'manual-temperature': 'Record manual temperature',
    'completed-relocation': 'Report completed whole-holder relocation',
    'impact-review': 'Record incident impact review',
    resolve: 'Resolve equipment incident',
  }[kind];
}

export function equipmentIncidentFollowUpDraft(
  action: Exclude<InventoryEquipmentIncidentAction, { kind: 'report' }>
): EquipmentIncidentFollowUpDraft {
  switch (action.kind) {
    case 'manual-temperature':
      return {
        kind: action.kind,
        incident: action.incident,
        supersedes: action.supersedes,
        readingKind: action.reading.kind,
        temperature: action.reading.kind === 'measured' ? action.reading.temperature.value : '',
        observedTime:
          action.reading.kind === 'measured'
            ? new Date(action.reading.observedAt).toISOString()
            : '',
        pointLabel: action.reading.kind === 'measured' ? action.reading.pointLabel : '',
      };
    case 'completed-relocation':
      return {
        kind: action.kind,
        incident: action.incident,
        moves: structuredClone(action.moves),
        corrects: action.corrects,
      };
    case 'impact-review':
      return {
        kind: action.kind,
        incident: action.incident,
        subjects: structuredClone(action.subjects),
        disposition: action.disposition,
        basis: action.basis,
      };
    case 'resolve':
      return { kind: action.kind, incident: action.incident, resolution: action.resolution };
  }
}
