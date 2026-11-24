import { describe, expect, it } from 'vitest';
import {
  CHROMATOGRAM_TYPE,
  createTrackInstance,
  resolveTrackSettings,
} from '@waypoint/genome-renderer';
import {
  createReadTrackBindingFactory,
  editReadTrackLayout as edit,
  resolveReadTrackLayout as resolve,
} from './read-track-presentation';
import { createGroupHeaderBindings } from './track-group-bands';
import type { SharedSequenceReadLane } from './shared-sequence-read-model';
import {
  normalizeSequenceViewStatePatch,
  modelPatchToTabViewState,
  tabViewStateToModelPatch,
} from '../view-state/sequence-view-state';

const lane = (id: string): SharedSequenceReadLane => ({
  id,
  label: id,
  kind: 'sanger',
  sequence: 'A',
  trace: {
    channels: { A: [0, 1], C: [0, 0], G: [0, 0], T: [0, 0] },
    maxValue: 1,
    peakPositions: [1],
    baseOrder: 'ACGT',
  },
  baseToColumn: [0],
  mutationColumns: [],
  deletionColumns: [],
});

describe('read tracks in one ordered view', () => {
  it('moves a whole group and its read settings through save, partial loading and restore', () => {
    const [a, b, c] = [lane('sanger-direct-tab-1'), lane('b'), lane('c')];
    let layout = resolve([a, b, c], undefined, { 'sanger-direct': 4 });
    layout = edit(layout, {
      type: 'create-group',
      id: 'group-1',
      label: 'Pair',
      trackIds: ['sanger-direct', 'b'],
    });
    layout = edit(layout, { type: 'move', id: 'group-1' });
    layout = edit(layout, { type: 'visibility', id: 'b', visible: false });
    layout = edit(layout, { type: 'resize', id: 'b', heightPx: 167 });
    const partial = resolve([c], layout);
    const restored = normalizeSequenceViewStatePatch(
      tabViewStateToModelPatch(modelPatchToTabViewState({ readTrackLayout: partial }))
    ).readTrackLayout;
    const factory = createReadTrackBindingFactory();
    const direct = lane('sanger-direct-reopened');
    const tracks = factory([direct, b, c], 'ref', resolve([direct, b, c], restored));
    expect(tracks.map((t) => t.key)).toEqual(['c', 'sanger-direct', 'b']);
    expect(tracks[1].data.gain).toBe(4);
    expect(tracks[2].track).toMatchObject({ visible: false, sizing: { pixels: 167 } });
    layout = edit(layout, { type: 'move', id: 'c', groupId: 'group-1', beforeId: 'b' });
    layout = edit(layout, { type: 'move', id: 'b', beforeId: 'group-1' });
    layout = edit(layout, { type: 'ungroup', id: 'group-1' });
    expect(layout.rows).toEqual(['b', 'sanger-direct', 'c'].map((id) => ({ kind: 'track', id })));
  });
  it('ignores invalid drops and retains track identity through gain changes', () => {
    const a = lane('a'),
      b = lane('b');
    let layout = resolve([a, b]);
    const initial = layout;
    expect(edit(layout, { type: 'move', id: 'a', groupId: 'missing' })).toBe(initial);
    expect(edit(layout, { type: 'move', id: 'a', beforeId: 'lane:reference' })).toBe(initial);
    const factory = createReadTrackBindingFactory();
    const before = factory([a, b], 'ref', layout);
    layout = edit(layout, { type: 'setting', id: 'a', key: 'gain', value: 8 });
    const after = factory([a, b], 'ref', layout);
    expect(after[0].track).toBe(before[0].track);
    expect(after[0].data.gain).toBe(8);
    expect(after[1].settings.gain).toBe(1);
    expect(after[0].controls[0].key).toBe('gain');
  });
  it('keeps group headers and reads in the same physical order while gain changes', () => {
    const a = lane('a');
    const b = lane('b');
    let layout = edit(resolve([a, b]), {
      type: 'create-group',
      id: 'pair',
      label: 'Pair',
      trackIds: ['b'],
    });
    layout = edit(layout, { type: 'create-group', id: 'empty', label: 'Next', trackIds: [] });
    const headers = createGroupHeaderBindings();
    const reads = createReadTrackBindingFactory();
    const before = headers(layout.rows, 'ref');
    const tracks = [...before, ...reads([a, b], 'ref', layout)].map((binding) => binding.track);
    expect(tracks.sort((x, y) => x.order - y.order).map((track) => track.id)).toEqual([
      'a',
      'pair',
      'b',
      'empty',
    ]);
    const adjusted = edit(layout, { type: 'setting', id: 'b', key: 'gain', value: 2 });
    expect(headers(adjusted.rows, 'ref')[0].track).toBe(before[0].track);
  });
  it('applies versioned per-type settings and preserves unrecognized keys', () => {
    const next = {
      ...CHROMATOGRAM_TYPE.settings,
      version: 2,
      migrations: {
        1: (v: Readonly<Record<string, unknown>>) => ({ ...v, gain: v.amplification }),
      },
    };
    expect(
      resolveTrackSettings(next, { version: 1, settings: { amplification: 4, channel: 'A' } })
    ).toMatchObject({ gain: 4, channel: 'A' });
    expect(
      createTrackInstance(CHROMATOGRAM_TYPE, { id: 'a', assemblyId: 'ref', order: 0 })
    ).toMatchObject({
      type: 'chromatogram',
      visible: true,
      sizing: CHROMATOGRAM_TYPE.defaultSizing,
    });
  });
});
