import {
  CHROMATOGRAM_TYPE,
  PixiSequenceReadTrackRenderer,
  type Track,
  type TrackRangeControl,
  createTrackInstance,
  resolveTrackSettings,
  migrateTrackSettings,
  SEQUENCE_READ_TRACK_TYPE,
  type TrackTypeDefinition,
} from '@waypoint/genome-renderer';
import type {
  ReadTrackLayout,
  ReadTrackPreferences,
  ReadTrackRow,
} from '../view-state/read-track-layout';
import type { SharedSequenceReadLane } from './shared-sequence-read-model';

export type {
  ReadTrackLayout,
  ReadTrackPreferences,
  ReadTrackRow,
} from '../view-state/read-track-layout';

export type ReadTrackCommand =
  | { type: 'move'; id: string; groupId?: string; beforeId?: string }
  | { type: 'create-group'; id: string; label: string; trackIds: readonly string[] }
  | { type: 'rename-group'; id: string; label: string }
  | { type: 'ungroup'; id: string }
  | { type: 'visibility'; id: string; visible: boolean }
  | { type: 'resize'; id: string; heightPx: number }
  | { type: 'setting'; id: string; key: string; value: number };

export function stableReadTrackId(id: string): string {
  return id.startsWith('sanger-direct-') ? 'sanger-direct' : id;
}

export function resolveReadTrackLayout(
  lanes: readonly SharedSequenceReadLane[],
  saved?: ReadTrackLayout,
  legacyGains?: Readonly<Record<string, number>>
): ReadTrackLayout {
  const seen = new Set<string>();
  const rows: ReadTrackRow[] = [];
  const tracks = { ...saved?.tracks };
  const add = (id: string) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  };
  for (const row of saved?.rows ?? []) {
    if (!add(row.id)) continue;
    rows.push(row.kind === 'group' ? { ...row, trackIds: row.trackIds.filter(add) } : row);
  }
  for (const lane of lanes) {
    const id = stableReadTrackId(lane.id);
    if (add(id)) rows.push({ kind: 'track', id });
    if (lane.kind !== 'sanger') continue;
    const previous = tracks[id];
    const schema = CHROMATOGRAM_TYPE.settings;
    if (previous?.version !== undefined && previous.version < schema.version) {
      tracks[id] = { ...previous, ...migrateTrackSettings(schema, previous) };
      continue;
    }
    const gain = legacyGains?.[id];
    const gainControl = schema.controls[0];
    if (
      gain !== undefined &&
      gain >= gainControl.min &&
      gain <= gainControl.max &&
      !previous?.version &&
      previous?.settings?.gain === undefined
    ) {
      tracks[id] = {
        ...previous,
        version: schema.version,
        settings: { ...previous?.settings, gain },
      };
    }
  }
  return { ...saved, version: 1, rows, tracks };
}

function leafIds(rows: readonly ReadTrackRow[]): string[] {
  return rows.flatMap((row) => (row.kind === 'track' ? [row.id] : [...row.trackIds]));
}

function removeTracks(rows: readonly ReadTrackRow[], ids: Set<string>): ReadTrackRow[] {
  return rows.flatMap((row): ReadTrackRow[] => {
    if (row.kind === 'track') return ids.has(row.id) ? [] : [row];
    return [{ ...row, trackIds: row.trackIds.filter((id) => !ids.has(id)) }];
  });
}

function insertBefore<T>(values: readonly T[], value: T, before: number): T[] {
  return [...values.slice(0, before), value, ...values.slice(before)];
}

export function editReadTrackLayout(
  layout: ReadTrackLayout,
  command: ReadTrackCommand
): ReadTrackLayout {
  const { rows, tracks } = layout;
  const { id } = command;
  const group = rows.find((row) => row.kind === 'group' && row.id === id);
  const leaves = leafIds(rows);
  switch (command.type) {
    case 'create-group': {
      const label = command.label.trim();
      if (!id || !label || group || leaves.includes(id)) return layout;
      const requested = new Set(command.trackIds);
      const members = leaves.filter((key) => requested.has(key));
      const first = rows.findIndex((row) => row.kind === 'track' && requested.has(row.id));
      const before = first < 0 ? rows.length : first;
      const newGroup: ReadTrackRow = { kind: 'group', id, label, trackIds: members };
      return {
        ...layout,
        rows: [
          ...removeTracks(rows.slice(0, before), requested),
          newGroup,
          ...removeTracks(rows.slice(before), requested),
        ],
      };
    }
    case 'rename-group':
      return group && command.label.trim()
        ? {
            ...layout,
            rows: rows.map((row) =>
              row.id === id && row.kind === 'group' ? { ...row, label: command.label.trim() } : row
            ),
          }
        : layout;
    case 'ungroup':
      return {
        ...layout,
        rows: rows.flatMap((row): ReadTrackRow[] =>
          row.id === id && row.kind === 'group'
            ? row.trackIds.map((id) => ({ kind: 'track', id }))
            : [row]
        ),
      };
    case 'move': {
      if (command.beforeId === id || (group && command.groupId) || (!group && !leaves.includes(id)))
        return layout;
      const next = group ? rows.filter((row) => row.id !== id) : removeTracks(rows, new Set([id]));
      if (command.groupId) {
        const dest = next.find((row) => row.id === command.groupId);
        if (dest?.kind !== 'group') return layout;
        const index =
          command.beforeId === undefined
            ? dest.trackIds.length
            : dest.trackIds.indexOf(command.beforeId);
        if (index < 0) return layout;
        return {
          ...layout,
          rows: next.map((row) =>
            row === dest ? { ...dest, trackIds: insertBefore(dest.trackIds, id, index) } : row
          ),
        };
      }
      const index =
        command.beforeId === undefined
          ? next.length
          : next.findIndex((row) => row.id === command.beforeId);
      return index < 0
        ? layout
        : { ...layout, rows: insertBefore(next, group ?? { kind: 'track', id }, index) };
    }
    default: {
      if (!leaves.includes(id)) return layout;
      const prior = tracks[id] ?? {};
      let pref: ReadTrackPreferences;
      if (command.type === 'visibility') pref = { ...prior, visible: command.visible };
      else if (command.type === 'resize') {
        if (!Number.isFinite(command.heightPx)) return layout;
        pref = { ...prior, heightPx: Math.max(32, Math.min(2048, Math.round(command.heightPx))) };
      } else {
        if (!Number.isFinite(command.value)) return layout;
        pref = {
          ...prior,
          version: prior.version ?? 1,
          settings: { ...prior.settings, [command.key]: command.value },
        };
      }
      return { ...layout, tracks: { ...tracks, [id]: pref } };
    }
  }
}

export interface ReadTrackBinding {
  key: string;
  track: Track;
  data: SharedSequenceReadLane & { gain?: number };
  renderer: PixiSequenceReadTrackRenderer;
  controls: readonly TrackRangeControl[];
  settings: Readonly<Record<string, unknown>>;
}

const ALIGNMENT_TYPE = {
  type: SEQUENCE_READ_TRACK_TYPE,
  family: 'reference',
  draw: 'sequence-band',
  dataShape: 'sequence',
  defaultSizing: { kind: 'fixed', pixels: 42 },
} satisfies TrackTypeDefinition;

export function createReadTrackBindingFactory() {
  const chromatogram = new PixiSequenceReadTrackRenderer(CHROMATOGRAM_TYPE.type);
  const alignment = new PixiSequenceReadTrackRenderer();
  let previous = new Map<string, ReadTrackBinding>();
  const amplified = new WeakMap<SharedSequenceReadLane, ReadTrackBinding['data']>();
  return (
    lanes: readonly SharedSequenceReadLane[],
    assemblyId: string,
    layout: ReadTrackLayout
  ): ReadTrackBinding[] => {
    const byId = new Map(lanes.map((lane) => [stableReadTrackId(lane.id), lane]));
    const bindings: ReadTrackBinding[] = [];
    for (const [order, key] of layout.rows
      .flatMap((row) => (row.kind === 'track' ? [row.id] : [row.id, ...row.trackIds]))
      .entries()) {
      const lane = byId.get(key);
      if (!lane) continue;
      const isTrace = lane.kind === 'sanger';
      const pref = layout.tracks[key];
      const renderer = isTrace ? chromatogram : alignment;
      const type = renderer.type;
      const definition = isTrace ? CHROMATOGRAM_TYPE : ALIGNMENT_TYPE;
      const settings: Readonly<Record<string, unknown>> = isTrace
        ? resolveTrackSettings(CHROMATOGRAM_TYPE.settings, pref)
        : {};
      const controls = isTrace ? CHROMATOGRAM_TYPE.settings.controls : [];
      const height =
        pref?.heightPx ??
        (isTrace ? CHROMATOGRAM_TYPE.defaultSizing.pixels : ALIGNMENT_TYPE.defaultSizing.pixels);
      const visible = pref?.visible ?? true;
      const old = previous.get(key);
      const t = old?.track;
      const track: Track =
        t &&
        t.id === lane.id &&
        t.type === type &&
        t.order === order &&
        t.visible === visible &&
        t.label === lane.label &&
        t.assemblyId === assemblyId &&
        t.sizing?.kind === 'fixed' &&
        t.sizing.pixels === height
          ? t
          : createTrackInstance(definition, {
              id: lane.id,
              order,
              visible,
              assemblyId,
              label: lane.label,
              zone: 'below-legacy',
              sizing: { kind: 'fixed', pixels: height },
            });
      const gain = settings.gain;
      let data: ReadTrackBinding['data'] = lane;
      if (isTrace && typeof gain === 'number' && gain !== 1) {
        const cached = amplified.get(lane);
        data = cached?.gain === gain ? cached : { ...lane, gain };
        amplified.set(lane, data);
      }
      bindings.push({ key, track, data, renderer, controls, settings });
    }
    previous = new Map(bindings.map((binding) => [binding.key, binding]));
    return bindings;
  };
}
