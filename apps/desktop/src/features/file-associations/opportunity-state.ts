import type { FileAssociationHandlerStatus } from '../../shared/file-association-ipc';
import {
  FILE_ASSOCIATION_FAMILIES,
  fileAssociationFamily,
  type FileAssociationFamilyId,
} from '../../shared/file-associations';

export const FILE_ASSOCIATION_OPPORTUNITY_SETTING_KEY = 'file_association_opportunities_v1';
export const FILE_ASSOCIATION_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
export const FILE_ASSOCIATION_PROMPT_CAP = 3;

export interface FileAssociationOpportunityRecord {
  readonly promptCount: number;
  readonly lastPromptedAt: number | null;
  readonly snoozedUntil: number | null;
  readonly permanentlyDismissed: boolean;
  readonly confirmedDefaultAt: number | null;
}

export interface FileAssociationOpportunityState {
  readonly version: 1;
  readonly families: Partial<Record<FileAssociationFamilyId, FileAssociationOpportunityRecord>>;
}

export type FileAssociationOpportunityReason =
  | 'eligible'
  | 'not-ready'
  | 'already-default'
  | 'handler-unavailable'
  | 'session-limit'
  | 'dismissed'
  | 'previously-confirmed'
  | 'snoozed'
  | 'prompt-cap';

export interface FileAssociationOpportunityDecision {
  readonly eligible: boolean;
  readonly reason: FileAssociationOpportunityReason;
}

const EMPTY_RECORD: FileAssociationOpportunityRecord = {
  promptCount: 0,
  lastPromptedAt: null,
  snoozedUntil: null,
  permanentlyDismissed: false,
  confirmedDefaultAt: null,
};

export function createOpportunityState(): FileAssociationOpportunityState {
  return { version: 1, families: {} };
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function parseRecord(value: unknown): FileAssociationOpportunityRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.promptCount !== 'number' ||
    !Number.isInteger(record.promptCount) ||
    record.promptCount < 0 ||
    typeof record.permanentlyDismissed !== 'boolean' ||
    !isNullableTimestamp(record.lastPromptedAt) ||
    !isNullableTimestamp(record.snoozedUntil) ||
    !isNullableTimestamp(record.confirmedDefaultAt)
  ) {
    return null;
  }
  return {
    promptCount: record.promptCount,
    lastPromptedAt: record.lastPromptedAt,
    snoozedUntil: record.snoozedUntil,
    permanentlyDismissed: record.permanentlyDismissed,
    confirmedDefaultAt: record.confirmedDefaultAt,
  };
}

export function parseOpportunityState(raw: string | null): FileAssociationOpportunityState {
  if (!raw) return createOpportunityState();
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return createOpportunityState();
    const state = value as Record<string, unknown>;
    if (state.version !== 1 || typeof state.families !== 'object' || state.families === null) {
      return createOpportunityState();
    }
    const familyValues = state.families as Record<string, unknown>;
    const families: FileAssociationOpportunityState['families'] = {};
    for (const family of FILE_ASSOCIATION_FAMILIES) {
      if (familyValues[family.id] === undefined) continue;
      const parsed = parseRecord(familyValues[family.id]);
      if (!parsed) return createOpportunityState();
      families[family.id] = parsed;
    }
    return { version: 1, families };
  } catch {
    return createOpportunityState();
  }
}

function updateRecord(
  state: FileAssociationOpportunityState,
  familyId: FileAssociationFamilyId,
  update: (record: FileAssociationOpportunityRecord) => FileAssociationOpportunityRecord
): FileAssociationOpportunityState {
  return {
    version: 1,
    families: {
      ...state.families,
      [familyId]: update(state.families[familyId] ?? EMPTY_RECORD),
    },
  };
}

export function recordOpportunityPrompted(
  state: FileAssociationOpportunityState,
  familyId: FileAssociationFamilyId,
  now: number
): FileAssociationOpportunityState {
  return updateRecord(state, familyId, (record) => ({
    ...record,
    promptCount: record.promptCount + 1,
    lastPromptedAt: now,
  }));
}

export function recordOpportunitySnoozed(
  state: FileAssociationOpportunityState,
  familyId: FileAssociationFamilyId,
  now: number
): FileAssociationOpportunityState {
  return updateRecord(state, familyId, (record) => ({
    ...record,
    snoozedUntil: now + FILE_ASSOCIATION_SNOOZE_MS,
  }));
}

export function recordOpportunityDismissed(
  state: FileAssociationOpportunityState,
  familyId: FileAssociationFamilyId
): FileAssociationOpportunityState {
  return updateRecord(state, familyId, (record) => ({
    ...record,
    permanentlyDismissed: true,
  }));
}

export function markConfirmedDefault(
  state: FileAssociationOpportunityState,
  familyId: FileAssociationFamilyId,
  now: number
): FileAssociationOpportunityState {
  return updateRecord(state, familyId, (record) => ({
    ...record,
    confirmedDefaultAt: record.confirmedDefaultAt ?? now,
  }));
}

export function evaluateOpportunity(input: {
  readonly state: FileAssociationOpportunityState;
  readonly familyId: FileAssociationFamilyId;
  readonly handlerStatus: FileAssociationHandlerStatus;
  readonly now: number;
  readonly sessionPrompted: boolean;
}): FileAssociationOpportunityDecision {
  const family = fileAssociationFamily(input.familyId);
  if (!family.promptReady) return { eligible: false, reason: 'not-ready' };
  if (input.handlerStatus.state === 'default') {
    return { eligible: false, reason: 'already-default' };
  }
  if (input.handlerStatus.state === 'unavailable' || input.handlerStatus.state === 'unsupported') {
    return { eligible: false, reason: 'handler-unavailable' };
  }
  if (input.sessionPrompted) return { eligible: false, reason: 'session-limit' };
  const record = input.state.families[input.familyId] ?? EMPTY_RECORD;
  if (record.permanentlyDismissed) return { eligible: false, reason: 'dismissed' };
  if (record.confirmedDefaultAt !== null) {
    return { eligible: false, reason: 'previously-confirmed' };
  }
  if (record.snoozedUntil !== null && input.now < record.snoozedUntil) {
    return { eligible: false, reason: 'snoozed' };
  }
  if (record.promptCount >= FILE_ASSOCIATION_PROMPT_CAP) {
    return { eligible: false, reason: 'prompt-cap' };
  }
  return { eligible: true, reason: 'eligible' };
}

export function selectOpportunityFamily(input: {
  readonly state: FileAssociationOpportunityState;
  readonly handlerStatuses: readonly FileAssociationHandlerStatus[];
  readonly successfulFamilies: ReadonlySet<FileAssociationFamilyId>;
  readonly now: number;
  readonly sessionPrompted: boolean;
}): FileAssociationFamilyId | null {
  const statuses = new Map(input.handlerStatuses.map((status) => [status.familyId, status]));
  for (const family of FILE_ASSOCIATION_FAMILIES) {
    if (!input.successfulFamilies.has(family.id)) continue;
    const handlerStatus = statuses.get(family.id);
    if (!handlerStatus) continue;
    if (
      evaluateOpportunity({
        state: input.state,
        familyId: family.id,
        handlerStatus,
        now: input.now,
        sessionPrompted: input.sessionPrompted,
      }).eligible
    ) {
      return family.id;
    }
  }
  return null;
}
