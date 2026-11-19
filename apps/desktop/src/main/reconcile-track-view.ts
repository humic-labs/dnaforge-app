import { isDeepStrictEqual } from 'node:util';
import { validateTrackViewDocument, type TrackViewDocument } from '../shared/track-view';

function equivalent(left: unknown, right: unknown): boolean {
  const dropAdmissionTimes = (key: string, value: unknown) =>
    key === 'admittedAt' || key === 'checkedAt' ? undefined : value;
  const normalize = (value: unknown) => JSON.parse(JSON.stringify([value], dropAdmissionTimes));
  return isDeepStrictEqual(left, right) || isDeepStrictEqual(normalize(left), normalize(right));
}

const conflict = Symbol('conflict');

function mergeValue(base: unknown, local: unknown, current: unknown): unknown {
  if (equivalent(local, base) || equivalent(local, current)) return current;
  return equivalent(current, base) ? local : conflict;
}

function mergeTrackSettings(
  base: ReadonlyArray<{ trackId: string }>,
  local: ReadonlyArray<{ trackId: string }>,
  current: ReadonlyArray<{ trackId: string }>
): unknown {
  const ids = (rows: typeof base) => rows.map((row) => row.trackId);
  if (!equivalent(ids(base), ids(local)) || !equivalent(ids(base), ids(current))) return conflict;
  const merged = [];
  for (const [index, original] of base.entries()) {
    const fields = (row: { trackId: string }): Record<string, unknown> => ({ ...row });
    const before = fields(original);
    const draft = fields(local[index]);
    const saved = fields(current[index]);
    const source = (row: Record<string, unknown>) => [
      row.source,
      row.admittedSource,
      row.remoteSignal,
      row.readsTrackId,
      row.signalTrackId,
    ];
    if (mergeValue(source(before), source(draft), source(saved)) === conflict) return conflict;
    const row = { ...saved };
    for (const field of Object.keys({ ...before, ...draft, ...saved })) {
      const value = mergeValue(before[field], draft[field], saved[field]);
      if (value === conflict) return conflict;
      row[field] = value;
    }
    merged.push(row);
  }
  return merged;
}

export function reconcileTrackView(
  base: TrackViewDocument,
  local: TrackViewDocument,
  current: TrackViewDocument
): TrackViewDocument | null {
  if (base.id !== local.id || base.id !== current.id) return null;
  if (
    !equivalent(base.reference, current.reference) ||
    !equivalent(base.reference, local.reference)
  )
    return null;
  const fields = Object.keys({ ...base, ...local, ...current }) as (keyof TrackViewDocument)[];
  const merged = { ...current, updatedAt: local.updatedAt };
  const navigation = (view: TrackViewDocument) => [view.scope, view.viewport];
  if (
    !equivalent(navigation(base), navigation(current)) &&
    !equivalent(navigation(base), navigation(local)) &&
    !equivalent(navigation(current), navigation(local))
  )
    return null;
  for (const field of fields) {
    if (field === 'updatedAt') continue;
    let value = mergeValue(base[field], local[field], current[field]);
    if (
      value === conflict &&
      (field === 'bamTracks' || field === 'dataTracks' || field === 'signalReadPileupViews')
    )
      value = mergeTrackSettings(base[field] ?? [], local[field] ?? [], current[field] ?? []);
    if (value === conflict) return null;
    Object.assign(merged, { [field]: value });
  }
  try {
    return validateTrackViewDocument(merged);
  } catch {
    return null;
  }
}
