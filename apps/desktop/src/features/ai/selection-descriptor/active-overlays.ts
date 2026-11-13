import { cutSiteRecognitionSelection, type ColoredCutSite } from '@waypoint/sequence-utils';

import type { PrimerDisplay } from '@waypoint/workspace-editor';
import {
  rangesOverlap,
  type SelectionRange,
} from '../../../../../../packages/core/workspace-editor/src/selection-model';

import { untrustedField } from './sanitize';
import { OVERLAP_FEATURE_CAP, overlapRelation } from './overlap';
import type {
  ActiveOverlaySnapshot,
  OverlappingCutSite,
  OverlappingOrf,
  OverlappingPrimer,
  OverlayLayer,
  VisibleOverlaysSnapshot,
} from './types';

const PRIMER_NAME_CAP = 120;

export type { ActiveOverlaySnapshot } from './types';

function strandFromCutSite(strand: ColoredCutSite['strand']): '+' | '-' {
  return strand === 'reverse' ? '-' : '+';
}

function strandFromPrimer(direction: PrimerDisplay['direction']): '+' | '-' {
  return direction === 'reverse' ? '-' : '+';
}

function capLayer<T>(items: T[]): OverlayLayer<T> {
  if (items.length <= OVERLAP_FEATURE_CAP) {
    return { visible: true, items };
  }
  return {
    visible: true,
    items: items.slice(0, OVERLAP_FEATURE_CAP),
    overflow: items.length - OVERLAP_FEATURE_CAP,
  };
}

function projectCutSites(
  layer: ActiveOverlaySnapshot['restrictionSites'],
  sel0: SelectionRange,
  seqLen: number
): OverlayLayer<OverlappingCutSite> {
  if (!layer.visible) return { visible: false };
  const kept: OverlappingCutSite[] = [];
  for (const site of layer.sites) {
    const feat0: SelectionRange = cutSiteRecognitionSelection(site, seqLen);
    if (!rangesOverlap(feat0, sel0, seqLen)) continue;
    kept.push({
      enzyme: site.enzyme.name,
      recognitionSequence: site.enzyme.recognition_sequence,
      start: site.recognitionStart + 1,
      end: site.recognitionEnd === 0 ? seqLen : site.recognitionEnd,
      strand: strandFromCutSite(site.strand),
      cutPosition: site.cutPositionTop + 1,
      relation: overlapRelation(feat0, sel0, seqLen),
    });
  }
  return capLayer(kept);
}

function projectOrfs(
  layer: ActiveOverlaySnapshot['orfs'],
  sel0: SelectionRange,
  seqLen: number
): OverlayLayer<OverlappingOrf> {
  if (!layer.visible) return { visible: false };
  const kept: OverlappingOrf[] = [];
  for (const orf of layer.items) {
    const feat0: SelectionRange = {
      start: orf.start,
      end: orf.end,
      wraps: orf.start > orf.end,
    };
    if (!rangesOverlap(feat0, sel0, seqLen)) continue;
    kept.push({
      start: orf.start + 1,
      end: orf.end + 1,
      strand: orf.strand,
      frame: orf.frame,
      lengthBp: orf.length,
      relation: overlapRelation(feat0, sel0, seqLen),
    });
  }
  return capLayer(kept);
}

function projectPrimers(
  layer: ActiveOverlaySnapshot['primers'],
  sel0: SelectionRange,
  seqLen: number
): OverlayLayer<OverlappingPrimer> {
  if (!layer.visible) return { visible: false };
  const kept: OverlappingPrimer[] = [];
  for (const primer of layer.items) {
    const end0 = primer.end - 1;
    const feat0: SelectionRange = {
      start: primer.start,
      end: end0,
      wraps: primer.start > end0,
    };
    if (!rangesOverlap(feat0, sel0, seqLen)) continue;
    const name = untrustedField(primer.name, PRIMER_NAME_CAP);
    kept.push({
      ...(name ? { name } : {}),
      start: primer.start + 1,
      end: primer.end,
      strand: strandFromPrimer(primer.direction),
      relation: overlapRelation(feat0, sel0, seqLen),
    });
  }
  return capLayer(kept);
}

export function projectVisibleOverlays(
  snapshot: ActiveOverlaySnapshot,
  sel0: SelectionRange,
  seqLen: number
): VisibleOverlaysSnapshot {
  return {
    restrictionSites: projectCutSites(snapshot.restrictionSites, sel0, seqLen),
    orfs: projectOrfs(snapshot.orfs, sel0, seqLen),
    primers: projectPrimers(snapshot.primers, sel0, seqLen),
  };
}
