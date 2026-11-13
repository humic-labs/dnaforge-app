import { describe, it, expect } from 'vitest';
import {
  computeUnifiedLayout,
  RESIDUE_NUMBER_ROW_HEIGHT,
  type UnifiedLayoutInputs,
} from './track-layout';
import type { Genome, RenderState } from '../../../types';

const GENOME: Genome = { name: 't', length: 1000, circular: false, features: [] };

function state(showResidueNumbers: boolean): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 1440,
    height: 900,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
    showResidueNumbers,
  };
}

function layout(showResidueNumbers: boolean, overrides?: Partial<UnifiedLayoutInputs>) {
  return computeUnifiedLayout({
    overlays: [],
    genome: GENOME,
    state: state(showResidueNumbers),
    pixelsPerBp: 3,
    viewportHeight: 900,
    hasSequence: true,
    translationLanes: 1,
    annotationLanes: 0,
    cdsLanes: 1,
    orfForwardLanes: 1,
    ...overrides,
  });
}

function laneEnvelope(l: ReturnType<typeof layout>, k: number): [number, number] {
  const center = l.cdsLaneOffset - k * l.cdsLaneStep;
  return [center - l.cdsLaneStep / 2, center + l.cdsLaneStep / 2];
}
function residueBand(l: ReturnType<typeof layout>, k: number): [number, number] {
  const center = l.cdsResidueRowOffset - k * l.cdsLaneStep;
  return [center - l.cdsResidueRowHeight / 2, center + l.cdsResidueRowHeight / 2];
}

describe('residue-row spatial contract (computeUnifiedLayout)', () => {
  it('reserves a non-zero band ONLY when the control is on', () => {
    const off = layout(false);
    expect(off.cdsResidueRowHeight).toBe(0);
    expect(off.cdsResidueRowOffset).toBe(0);

    const on = layout(true);
    expect(on.cdsResidueRowHeight).toBeGreaterThan(0);
    expect(on.cdsResidueRowOffset).not.toBe(0);
  });

  it('does NOT reserve the band below sequence-LOD even when the control is on', () => {
    const lowZoomOn = layout(true, { pixelsPerBp: 0.05 });
    expect(lowZoomOn.cdsResidueRowHeight).toBe(0);
    expect(lowZoomOn.cdsResidueRowOffset).toBe(0);
    const lowZoomOff = layout(false, { pixelsPerBp: 0.05 });
    expect(lowZoomOn.cdsLaneStep).toBeCloseTo(lowZoomOff.cdsLaneStep, 5);
  });

  it('grows the CDS lane by exactly its reserved residue band (reservation, not theft)', () => {
    const off = layout(false);
    const on = layout(true);
    const grew = on.cdsLaneStep - off.cdsLaneStep;
    expect(grew).toBeGreaterThan(0);
    expect(grew).toBeCloseTo(on.cdsResidueRowHeight, 5);
    expect(on.cdsResidueRowHeight).toBeLessThanOrEqual(RESIDUE_NUMBER_ROW_HEIGHT + 1e-6);
  });

  it('never pulls the track BELOW the CDS stack UP into reserved space', () => {
    const off = layout(false);
    const on = layout(true);
    expect(on.orfForwardTop).toBeGreaterThanOrEqual(off.orfForwardTop - 1e-6);
  });

  it('keeps the reserved band strictly INSIDE the CDS lane envelope', () => {
    const l = layout(true);
    const [envIn, envOut] = laneEnvelope(l, 0);
    const [bIn, bOut] = residueBand(l, 0);
    expect(bIn).toBeGreaterThanOrEqual(envIn - 1e-6);
    expect(bOut).toBeLessThanOrEqual(envOut + 1e-6);
  });

  it('does NOT overlap the chevron sub-region', () => {
    const l = layout(true);
    const [bIn] = residueBand(l, 0);
    expect(bIn).toBeGreaterThanOrEqual(l.cdsChevronOffset - 1e-6);
  });

  it('multi-lane: every lane’s residue band stays within its OWN envelope', () => {
    const l = layout(true, { cdsLanes: 3 });
    for (let k = 0; k < 3; k++) {
      const [envIn, envOut] = laneEnvelope(l, k);
      const [bIn, bOut] = residueBand(l, k);
      expect(bIn).toBeGreaterThanOrEqual(envIn - 1e-6);
      expect(bOut).toBeLessThanOrEqual(envOut + 1e-6);
    }
  });

  it('label-bar ↔ chevron gap is invariant to the Residue Numbers toggle', () => {
    const off = layout(false);
    const on = layout(true);
    const gapOff = off.cdsChevronOffset - off.cdsBarOffset;
    const gapOn = on.cdsChevronOffset - on.cdsBarOffset;
    expect(gapOn).toBeGreaterThan(0);
    expect(gapOn).toBeCloseTo(gapOff, 5);
  });
});
