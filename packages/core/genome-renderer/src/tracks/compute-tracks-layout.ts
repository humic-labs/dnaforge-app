import type {
  ComputeTracksLayoutOptions,
  Track,
  TrackContentHeightResolver,
  TrackLayout,
  TrackLayoutEntry,
  TrackSizingProfile,
} from './types';
import { TrackLayoutInputError } from './types';

const DEFAULT_MIN_HEIGHT = 0;

export function computeTracksLayout(
  tracks: ReadonlyArray<Track>,
  contentHeightFor: TrackContentHeightResolver,
  options: ComputeTracksLayoutOptions
): TrackLayout {
  if (tracks.length === 0) return [];

  const seen = new Set<string>();
  for (const t of tracks) {
    if (seen.has(t.id)) {
      throw new TrackLayoutInputError(
        `Duplicate track id "${t.id}" — track instance IDs must be unique within a layout pass.`,
        'duplicate-id'
      );
    }
    seen.add(t.id);
  }

  const availableHeight = Math.max(0, options.availableHeight);

  const visibleIndices: number[] = [];
  const hiddenIndices: number[] = [];
  for (let i = 0; i < tracks.length; i++) {
    if (tracks[i].visible) visibleIndices.push(i);
    else hiddenIndices.push(i);
  }

  const sortedVisible = [...visibleIndices].sort((a, b) => {
    const oa = tracks[a].order;
    const ob = tracks[b].order;
    if (oa !== ob) return oa - ob;
    return a - b;
  });

  type Slot = {
    inputIndex: number;
    profile: ResolvedSizingProfile;
    contentHeight: number;
    desired: number;
  };
  const slots: Slot[] = sortedVisible.map((idx) => {
    const t = tracks[idx];
    const profile = resolveSizingProfile(t.sizing);
    const content = Math.max(0, Math.floor(contentHeightFor(t)));
    const desired = desiredHeight(profile, content);
    return { inputIndex: idx, profile, contentHeight: content, desired };
  });

  const nonFlexDesired = slots.reduce(
    (sum, s) => sum + (s.profile.kind === 'flex' ? 0 : s.desired),
    0
  );

  const heightByInputIndex = new Map<number, number>();
  const clippedByInputIndex = new Set<number>();

  if (nonFlexDesired <= availableHeight) {
    const leftover = availableHeight - nonFlexDesired;
    const flexSlots = slots.filter((s) => s.profile.kind === 'flex');
    const totalShare = flexSlots.reduce(
      (sum, s) => sum + (s.profile.kind === 'flex' ? s.profile.share : 0),
      0
    );
    for (const s of slots) {
      if (s.profile.kind === 'flex') continue;
      heightByInputIndex.set(s.inputIndex, s.desired);
      if (s.profile.kind === 'fitContent' && s.desired < s.contentHeight) {
        clippedByInputIndex.add(s.inputIndex);
      }
    }
    if (totalShare > 0) {
      let allocated = 0;
      for (let i = 0; i < flexSlots.length; i++) {
        const s = flexSlots[i];
        const share = s.profile.kind === 'flex' ? s.profile.share : 0;
        const proportional = (leftover * share) / totalShare;
        let h = i === flexSlots.length - 1 ? leftover - allocated : Math.floor(proportional);
        h = clampToBounds(h, s.profile);
        if (h < s.contentHeight) clippedByInputIndex.add(s.inputIndex);
        heightByInputIndex.set(s.inputIndex, h);
        allocated += h;
      }
    }
  } else {
    let remaining = availableHeight;
    for (const s of slots) {
      if (s.profile.kind !== 'flex') continue;
      const floor = s.profile.minHeight ?? DEFAULT_MIN_HEIGHT;
      const h = Math.min(floor, remaining);
      heightByInputIndex.set(s.inputIndex, h);
      remaining -= h;
      if (h < s.contentHeight) clippedByInputIndex.add(s.inputIndex);
    }
    const nonFlex = slots.filter((s) => s.profile.kind !== 'flex');
    const nonFlexDesiredSum = nonFlex.reduce((sum, s) => sum + s.desired, 0);
    if (nonFlexDesiredSum <= remaining) {
      for (const s of nonFlex) {
        heightByInputIndex.set(s.inputIndex, s.desired);
        if (s.profile.kind === 'fitContent' && s.desired < s.contentHeight) {
          clippedByInputIndex.add(s.inputIndex);
        }
      }
    } else {
      const fixedSlots = nonFlex.filter((s) => s.profile.kind === 'fixed');
      const fitSlots = nonFlex.filter((s) => s.profile.kind === 'fitContent');
      const fixedTotal = fixedSlots.reduce((sum, s) => sum + s.desired, 0);
      if (fixedTotal <= remaining) {
        for (const s of fixedSlots) {
          heightByInputIndex.set(s.inputIndex, s.desired);
        }
        const fitBudget = remaining - fixedTotal;
        const fitDesired = fitSlots.reduce((sum, s) => sum + s.desired, 0);
        if (fitDesired <= 0) {
          for (const s of fitSlots) heightByInputIndex.set(s.inputIndex, 0);
        } else {
          let allocated = 0;
          for (let i = 0; i < fitSlots.length; i++) {
            const s = fitSlots[i];
            const proportional = (fitBudget * s.desired) / fitDesired;
            let h = i === fitSlots.length - 1 ? fitBudget - allocated : Math.floor(proportional);
            h = clampToBounds(h, s.profile);
            if (h < s.contentHeight) clippedByInputIndex.add(s.inputIndex);
            heightByInputIndex.set(s.inputIndex, h);
            allocated += h;
          }
        }
      } else {
        let budgetLeft = remaining;
        for (const s of fixedSlots) {
          const take = Math.min(s.desired, budgetLeft);
          heightByInputIndex.set(s.inputIndex, take);
          if (take < s.desired) clippedByInputIndex.add(s.inputIndex);
          budgetLeft -= take;
        }
        for (const s of fitSlots) {
          heightByInputIndex.set(s.inputIndex, 0);
          clippedByInputIndex.add(s.inputIndex);
        }
      }
    }
  }

  const layout: TrackLayoutEntry[] = new Array(tracks.length);
  let runningTop = 0;
  for (const idx of sortedVisible) {
    const height = Math.max(0, heightByInputIndex.get(idx) ?? 0);
    layout[idx] = {
      id: tracks[idx].id,
      top: runningTop,
      height,
      contentClipped: clippedByInputIndex.has(idx),
      hidden: false,
    };
    runningTop += height;
  }
  for (const idx of hiddenIndices) {
    layout[idx] = {
      id: tracks[idx].id,
      top: 0,
      height: 0,
      contentClipped: false,
      hidden: true,
    };
  }
  return layout;
}

export function layoutMemoKey(
  tracks: ReadonlyArray<Track>,
  contentHeightFor: TrackContentHeightResolver,
  options: ComputeTracksLayoutOptions
): string {
  const parts: string[] = [`avail=${Math.max(0, options.availableHeight)}`];
  for (const t of tracks) {
    const profile = encodeSizingProfile(t.sizing);
    const content = Math.max(0, Math.floor(contentHeightFor(t)));
    parts.push(`${t.id}|${t.type}|o=${t.order}|v=${t.visible ? 1 : 0}|s=${profile}|c=${content}`);
  }
  return parts.join(';');
}

interface ResolvedFixed {
  kind: 'fixed';
  pixels: number;
  minHeight: number;
  maxHeight: number;
}
interface ResolvedFit {
  kind: 'fitContent';
  minHeight: number;
  maxHeight: number;
}
interface ResolvedFlex {
  kind: 'flex';
  share: number;
  minHeight: number;
  maxHeight: number;
}
type ResolvedSizingProfile = ResolvedFixed | ResolvedFit | ResolvedFlex;

function resolveSizingProfile(p: TrackSizingProfile | undefined): ResolvedSizingProfile {
  if (!p) {
    return {
      kind: 'flex',
      share: 1,
      minHeight: DEFAULT_MIN_HEIGHT,
      maxHeight: Number.POSITIVE_INFINITY,
    };
  }
  const minHeight = Math.max(0, Math.floor(p.minHeight ?? DEFAULT_MIN_HEIGHT));
  const maxHeight =
    p.maxHeight !== undefined
      ? Math.max(minHeight, Math.floor(p.maxHeight))
      : Number.POSITIVE_INFINITY;
  if (p.kind === 'fixed') {
    return { kind: 'fixed', pixels: Math.max(0, Math.floor(p.pixels)), minHeight, maxHeight };
  }
  if (p.kind === 'fitContent') {
    return { kind: 'fitContent', minHeight, maxHeight };
  }
  return { kind: 'flex', share: Math.max(0, p.share ?? 1), minHeight, maxHeight };
}

function desiredHeight(profile: ResolvedSizingProfile, content: number): number {
  if (profile.kind === 'fixed') {
    return clampToBounds(profile.pixels, profile);
  }
  if (profile.kind === 'fitContent') {
    return clampToBounds(content, profile);
  }
  return 0;
}

function clampToBounds(h: number, profile: ResolvedSizingProfile): number {
  const min = profile.minHeight;
  const max = profile.maxHeight;
  if (h < min) return min;
  if (h > max) return max;
  return Math.floor(h);
}

function encodeSizingProfile(p: TrackSizingProfile | undefined): string {
  if (!p) return 'default';
  if (p.kind === 'fixed') return `fixed:${p.pixels}/${p.minHeight ?? 0}-${p.maxHeight ?? '∞'}`;
  if (p.kind === 'fitContent') return `fit:${p.minHeight ?? 0}-${p.maxHeight ?? '∞'}`;
  return `flex:${p.share ?? 1}/${p.minHeight ?? 0}-${p.maxHeight ?? '∞'}`;
}
