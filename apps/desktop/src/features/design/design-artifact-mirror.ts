import { useDesignStore } from './store';
import type { SequenceDesign } from './types';
import { writeDesignArtifactSnapshot } from '../../db/workspace-artifacts';
import { writePackageAssemblyWorkingCopySnapshot } from '../../db/sequence-package-working-copy-storage';
import { isPackageAssemblyWorkingCopyDesign } from './package-working-copy-identity';
import { isWorkspaceMutationBusyError } from '../../services/workspace-mutation-transaction';
import {
  captureDesignRecovery,
  DesignArtifactConflictError,
  DesignArtifactRetiredError,
  designContentIdentity,
  loadDesignRecovery,
  onDesignArtifactPublication,
  persistDesignRecovery,
  useDesignRecoveryStore,
} from './design-recovery';

let mirrorUnsubscribe: (() => void) | null = null;
let publicationUnsubscribe: (() => void) | null = null;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const writes = new Map<string, Promise<void>>();
const failures = new Map<string, number>();
const nextAttempts = new Map<string, number>();
const suspended = new Set<string>();
const draining = new Map<string, number>();

function isSuspended(designId: string): boolean {
  return suspended.has(designId) || draining.has(designId);
}

function backoffMs(count: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, count - 1));
}

function schedule(designId: string, delay = 250): void {
  const record = useDesignRecoveryStore.getState().records[designId];
  if (!mirrorUnsubscribe || isSuspended(designId) || !record?.pending || record.retired) return;
  if (record.status === 'conflict') return;
  const existing = timers.get(designId);
  if (existing) clearTimeout(existing);
  timers.set(
    designId,
    setTimeout(
      () => {
        timers.delete(designId);
        if (writes.has(designId)) return;
        const write = publish(designId);
        writes.set(designId, write);
        void write.finally(() => {
          writes.delete(designId);
          const latest = useDesignRecoveryStore.getState().records[designId];
          if (latest?.pending) {
            const count = failures.get(designId) ?? 0;
            schedule(designId, count ? backoffMs(count) : 250);
          }
        });
      },
      Math.max(delay, (nextAttempts.get(designId) ?? 0) - Date.now())
    )
  );
}

async function publish(designId: string, allowSuspended = false): Promise<void> {
  const record = useDesignRecoveryStore.getState().records[designId];
  if (!record?.pending || record.retired || (isSuspended(designId) && !allowSuspended)) return;
  persistDesignRecovery(designId, record);
  try {
    const snapshot = {
      designId,
      name: record.design.name,
      design: record.design,
      recovery: {
        base: record.base,
        attempted: record.attempted,
        beforeWrite: () => {
          const latest = useDesignRecoveryStore.getState().records[designId];
          if (latest) persistDesignRecovery(designId, { ...latest, attempted: record.revision });
        },
      },
    };

    const result = isPackageAssemblyWorkingCopyDesign(record.design)
      ? await writePackageAssemblyWorkingCopySnapshot(snapshot)
      : await writeDesignArtifactSnapshot(snapshot);
    const latest = useDesignRecoveryStore.getState().records[designId];
    if (!latest || latest.retired) return;
    if (!result) {
      failures.set(designId, 7);
      nextAttempts.set(designId, Date.now() + 60_000);
      persistDesignRecovery(designId, { ...latest, status: 'unbound' });
      return;
    }
    failures.delete(designId);
    nextAttempts.delete(designId);
    const pending = latest.revision !== record.revision;
    persistDesignRecovery(designId, {
      ...latest,
      base: record.revision,
      attempted: undefined,
      pending,
      status: pending ? 'saving' : 'saved',
    });
  } catch (error) {
    const latest = useDesignRecoveryStore.getState().records[designId];
    if (!latest || latest.retired) return;
    if (error instanceof DesignArtifactRetiredError) {
      persistDesignRecovery(designId, {
        ...latest,
        retired: true,
        pending: false,
        status: 'retired',
      });
    } else if (error instanceof DesignArtifactConflictError) {
      persistDesignRecovery(designId, { ...latest, status: 'conflict', conflict: error.design });
    } else {
      if (!isWorkspaceMutationBusyError(error)) {
        const count = (failures.get(designId) ?? 0) + 1;
        failures.set(designId, count);
        nextAttempts.set(designId, Date.now() + backoffMs(count));
      }
      persistDesignRecovery(designId, { ...latest, status: 'delayed' });
    }
  }
}

export function hasPendingDesignArtifactMirror(designIds: readonly string[]): boolean {
  return designIds.some((id) => {
    const record = useDesignRecoveryStore.getState().records[id];
    return Boolean((record?.pending && !record.retired) || writes.has(id));
  });
}

export function suspendDesignArtifactMirrors(designIds: readonly string[]): void {
  for (const id of designIds) {
    suspended.add(id);
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  }
}

export async function drainDesignArtifactMirrors(designIds: readonly string[]): Promise<void> {
  await Promise.all(
    designIds.map(async (id) => {
      await writes.get(id);
      if (useDesignRecoveryStore.getState().records[id]?.pending) {
        await publish(id, true);
      }
      const record = useDesignRecoveryStore.getState().records[id];
      if (record?.pending || record?.status === 'conflict') {
        throw new Error(
          `Assembly working copy ${id} could not be durably saved before finalization.`
        );
      }
    })
  );
}

export async function withDrainedDesignArtifactMirror<T>(
  designId: string,
  operation: () => Promise<T>
): Promise<T> {
  draining.set(designId, (draining.get(designId) ?? 0) + 1);
  const timer = timers.get(designId);
  if (timer) clearTimeout(timer);
  timers.delete(designId);
  try {
    await writes.get(designId);
    return await operation();
  } finally {
    const remaining = (draining.get(designId) ?? 1) - 1;
    if (remaining > 0) draining.set(designId, remaining);
    else {
      draining.delete(designId);
      const design = useDesignStore.getState().designs[designId];
      if (design) captureDesignRecovery(design);
      schedule(designId);
    }
  }
}

export function resumeDesignArtifactMirrors(
  designIds: readonly string[],
  options: { scheduleLatest: boolean }
): void {
  for (const id of designIds) {
    suspended.delete(id);
    if (!options.scheduleLatest) continue;
    const design = useDesignStore.getState().designs[id];
    if (design) captureDesignRecovery(design);
    schedule(id);
  }
}

export async function retireDesignArtifactMirror(designId: string): Promise<void> {
  const record = useDesignRecoveryStore.getState().records[designId];
  if (record) {
    persistDesignRecovery(designId, {
      ...record,
      retired: true,
      pending: false,
      status: 'retired',
    });
    if (!useDesignRecoveryStore.getState().records[designId].durable) {
      persistDesignRecovery(designId, { ...record, retired: false });
      throw new Error(
        'The assembly recovery record could not be saved. Keep the draft until saving recovers.'
      );
    }
  }
  const timer = timers.get(designId);
  if (timer) clearTimeout(timer);
  timers.delete(designId);
  await writes.get(designId);
}

export async function discardDesignArtifactChanges(designId: string): Promise<void> {
  await writes.get(designId);
  const record = useDesignRecoveryStore.getState().records[designId];
  if (!record?.pending || record.retired) return;
  const base = record.base;
  const saved = base ? (JSON.parse(base) as SequenceDesign | null) : null;
  if (!base || !saved) throw new Error('The saved assembly is unavailable.');
  const timer = timers.get(designId);
  if (timer) clearTimeout(timer);
  timers.delete(designId);
  persistDesignRecovery(designId, {
    ...record,
    design: saved,
    revision: base,
    attempted: undefined,
    conflict: undefined,
    pending: false,
    status: 'saved',
  });
  if (!useDesignRecoveryStore.getState().records[designId].durable) {
    persistDesignRecovery(designId, record);
    schedule(designId);
    throw new Error(
      'The assembly recovery record could not be saved. Keep the assembly open until saving recovers.'
    );
  }
  failures.delete(designId);
  nextAttempts.delete(designId);
  useDesignStore.getState().upsertDesignFromArtifact(saved);
}

export function resumeDesignArtifactMirror(designId: string): void {
  const record = useDesignRecoveryStore.getState().records[designId];
  if (record) {
    persistDesignRecovery(designId, {
      ...record,
      retired: false,
      pending: true,
      status: 'saving',
    });
  }
  const design = useDesignStore.getState().designs[designId];
  if (design) captureDesignRecovery(design);
  schedule(designId);
}

export function retryDesignArtifactMirrors(): void {
  for (const id of Object.keys(useDesignRecoveryStore.getState().records)) {
    nextAttempts.delete(id);
    schedule(id, 0);
  }
}

export function retryDesignArtifactMirror(id: string): void {
  nextAttempts.delete(id);
  schedule(id, 0);
}

export function resolveDesignArtifactConflict(id: string, choice: 'local' | 'external'): void {
  const record = useDesignRecoveryStore.getState().records[id];
  if (!record || record.status !== 'conflict') return;
  const external = record.conflict ?? null;
  if (choice === 'external' && !external) return;
  const chosen = choice === 'external' && external ? external : record.design;
  const preserved = choice === 'local' ? external : record.design;
  persistDesignRecovery(id, {
    ...record,
    design: chosen,
    revision: designContentIdentity(chosen),
    base: designContentIdentity(external),
    attempted: undefined,
    conflict: undefined,
    alternatives: [...(record.alternatives ?? []), ...(preserved ? [preserved] : [])],
    pending: true,
    status: 'saving',
  });
  useDesignStore.getState().upsertDesignFromArtifact(chosen);
  nextAttempts.delete(id);
  schedule(id);
}

export function startDesignArtifactMirroring(): () => void {
  if (mirrorUnsubscribe) return stopDesignArtifactMirroring;
  loadDesignRecovery();
  for (const record of Object.values(useDesignRecoveryStore.getState().records)) {
    if (record.pending && !record.retired) {
      useDesignStore.getState().upsertDesignFromArtifact(record.design);
    }
  }
  mirrorUnsubscribe = useDesignStore.subscribe((state, previous) => {
    for (const [id, design] of Object.entries(state.designs)) {
      if (state.draftDesignIds?.[id]) continue;
      if (isSuspended(id) || design === previous.designs[id]) continue;
      captureDesignRecovery(design, previous.designs[id]);
      schedule(id);
    }
  });
  let stopped = false;
  const unsubscribe = onDesignArtifactPublication((designId) => {
    const wake = () => {
      if (stopped) return;
      failures.delete(designId);
      nextAttempts.delete(designId);
      schedule(designId);
    };

    const write = writes.get(designId);
    if (write) void write.then(wake, wake);
    else wake();
  });
  publicationUnsubscribe = () => {
    stopped = true;
    unsubscribe();
  };
  retryDesignArtifactMirrors();
  window.addEventListener('online', retryDesignArtifactMirrors);
  window.addEventListener('waypoint:workspace-files-changed', retryDesignArtifactMirrors);
  return stopDesignArtifactMirroring;
}

export function stopDesignArtifactMirroring(): void {
  mirrorUnsubscribe?.();
  mirrorUnsubscribe = null;
  publicationUnsubscribe?.();
  publicationUnsubscribe = null;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  suspended.clear();
  draining.clear();
  failures.clear();
  nextAttempts.clear();
  window.removeEventListener('online', retryDesignArtifactMirrors);
  window.removeEventListener('waypoint:workspace-files-changed', retryDesignArtifactMirrors);
}
