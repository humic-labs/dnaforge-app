import { create } from 'zustand';
import type { SequenceDesign } from './types';

const STORAGE_PREFIX = 'waypoint-design-recovery-v1:';
const STATUSES = ['saving', 'delayed', 'unbound', 'conflict', 'saved', 'retired'] as const;
const publicationListeners = new Set<(designId: string) => void>();

export type DesignRecoveryStatus = (typeof STATUSES)[number];

export function designContentIdentity(design: SequenceDesign | null): string {
  return serializeDesign(design);
}

function serializeDesign(design: SequenceDesign | null): string {
  return JSON.stringify(design, (key, value: unknown) => {
    if (key === 'proposedPlans') return undefined;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    }
    return value;
  });
}

export interface DesignRecoveryRecord {
  serial?: number;
  design: SequenceDesign;
  revision: string;
  base: string | null;
  attempted?: string;
  pending: boolean;
  retired?: boolean;
  conflict?: SequenceDesign | null;
  alternatives?: SequenceDesign[];
  status: DesignRecoveryStatus;
  durable: boolean;
}

export const useDesignRecoveryStore = create<{
  records: Record<string, DesignRecoveryRecord>;
}>(() => ({ records: {} }));

function isStatus(value: unknown): value is DesignRecoveryStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

function isDesign(value: unknown): value is SequenceDesign {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

function isRecoveryRecord(value: unknown): value is DesignRecoveryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isDesign(record.design) &&
    typeof record.revision === 'string' &&
    (record.base === null || typeof record.base === 'string') &&
    typeof record.pending === 'boolean' &&
    isStatus(record.status)
  );
}

export function persistDesignRecovery(id: string, record: DesignRecoveryRecord): void {
  record = {
    ...record,
    serial:
      Math.max(record.serial ?? 0, useDesignRecoveryStore.getState().records[id]?.serial ?? 0) + 1,
  };
  let durable = false;
  try {
    const serialized = JSON.stringify({ ...record, durable: true });
    localStorage.setItem(STORAGE_PREFIX + id, serialized);
    durable = localStorage.getItem(STORAGE_PREFIX + id) === serialized;
  } catch {}
  useDesignRecoveryStore.setState((state) => ({
    records: { ...state.records, [id]: { ...record, durable } },
  }));
}

export function loadDesignRecovery(): void {
  const accept = (id: string, value: unknown) => {
    if (
      !isRecoveryRecord(value) ||
      value.design.id !== id ||
      value.revision !== designContentIdentity(value.design)
    )
      return;
    if (value.serial !== undefined && (!Number.isSafeInteger(value.serial) || value.serial < 0))
      return;
    const current = useDesignRecoveryStore.getState().records[id];
    if (current && (current.serial ?? 0) >= (value.serial ?? 0)) return;
    useDesignRecoveryStore.setState((state) => ({
      records: { ...state.records, [id]: { ...value, durable: true } },
    }));
  };
  try {
    const backup = JSON.parse(localStorage.getItem('waypoint-designs') ?? 'null') as {
      state?: { designRecoveryRecords?: Record<string, unknown> };
    } | null;
    for (const [id, record] of Object.entries(backup?.state?.designRecoveryRecords ?? {}))
      accept(id, record);
  } catch {}
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      try {
        accept(key.slice(STORAGE_PREFIX.length), JSON.parse(localStorage.getItem(key) ?? 'null'));
      } catch {}
    }
  } catch {}
}

export function confirmDesignRecoveryBackup(records: Record<string, DesignRecoveryRecord>): void {
  useDesignRecoveryStore.setState((state) => ({
    records: Object.fromEntries(
      Object.entries(state.records).map(([id, record]) => [
        id,
        records[id] && records[id].serial === record.serial ? { ...record, durable: true } : record,
      ])
    ),
  }));
}

export function captureDesignRecovery(design: SequenceDesign, previous?: SequenceDesign): void {
  const existing = useDesignRecoveryStore.getState().records[design.id];
  if (existing?.retired) return;
  const revision = designContentIdentity(design);
  if (existing?.revision === revision) return;
  persistDesignRecovery(design.id, {
    ...existing,
    design: JSON.parse(serializeDesign(design)) as SequenceDesign,
    revision,
    base: existing?.base ?? (previous ? designContentIdentity(previous) : revision),
    pending: true,
    status: existing?.status === 'conflict' ? 'conflict' : 'saving',
    durable: false,
  });
}

export function acceptDesignArtifact(design: SequenceDesign): boolean {
  loadDesignRecovery();
  const existing = useDesignRecoveryStore.getState().records[design.id];
  const revision = designContentIdentity(design);
  if (existing?.pending && !existing.retired) {
    if (
      revision !== existing.base &&
      revision !== existing.attempted &&
      revision !== existing.revision
    ) {
      persistDesignRecovery(design.id, { ...existing, conflict: design, status: 'conflict' });
    }
    return false;
  }
  persistDesignRecovery(design.id, {
    ...existing,
    design,
    revision,
    base: revision,
    pending: false,
    retired: false,
    status: 'saved',
    durable: false,
  });
  return true;
}

export function hasUnrecoverableDesignWork(): string[] {
  return Object.entries(useDesignRecoveryStore.getState().records)
    .filter(([, record]) => record.pending && !record.retired && !record.durable)
    .map(([id]) => id);
}

export function beginDesignArtifactPublication(design: SequenceDesign): void {
  const record = useDesignRecoveryStore.getState().records[design.id];
  if (record && !record.retired) {
    persistDesignRecovery(design.id, { ...record, attempted: designContentIdentity(design) });
  }
}

export function confirmDesignArtifactPublication(design: SequenceDesign): void {
  const record = useDesignRecoveryStore.getState().records[design.id];
  if (!record || record.retired) return;
  const revision = designContentIdentity(design);
  const pending = record.revision !== revision;
  persistDesignRecovery(design.id, {
    ...record,
    base: revision,
    attempted: undefined,
    pending,
    status: pending ? 'saving' : 'saved',
  });
  for (const listener of publicationListeners) listener(design.id);
}

export function onDesignArtifactPublication(listener: (designId: string) => void): () => void {
  publicationListeners.add(listener);
  return () => publicationListeners.delete(listener);
}

export class DesignArtifactConflictError extends Error {
  constructor(readonly design: SequenceDesign | null) {
    super('The assembly was changed elsewhere. Both versions have been kept.');
    this.name = 'DesignArtifactConflictError';
  }
}

export class DesignArtifactRetiredError extends Error {
  constructor() {
    super('This draft has been consumed by an assembly product.');
    this.name = 'DesignArtifactRetiredError';
  }
}

loadDesignRecovery();
