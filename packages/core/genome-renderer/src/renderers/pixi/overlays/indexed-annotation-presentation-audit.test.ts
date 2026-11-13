import { afterEach, describe, expect, it } from 'vitest';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { normalizeAnnotationLayerTypes } from './annotation-feature-semantics';
import type { OverlayLayoutHost } from './indexed-annotation-layout';
import {
  beginDrawAudit,
  beginDrawAuditIfDiagnosticsEnabled,
  recordDrawAuditDecision,
  renderSetLayerTypesForAudit,
  type BeginDrawAuditHost,
} from './indexed-annotation-presentation-audit';
import { RETAINED_TRANSCRIPT_KEY_CACHE_MIN_FEATURES } from './indexed-annotation-retained-source-window';

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 1,
    type: 'gene',
    start: 10,
    end: 60,
    direction: 'forward',
    color: 0x3366ff,
    lane: 0,
    displayName: 'gene',
    ...overrides,
  };
}

function renderState(overrides: Partial<RenderState> = {}): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 400,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
    ...overrides,
  };
}

function auditHost(overrides: Partial<BeginDrawAuditHost> = {}): BeginDrawAuditHost {
  return {
    drawAuditFrameId: 3,
    lastRenderMode: 'retained',
    features: { length: 10 },
    renderSetLayerTypesForAudit() {
      return ['mRNA'];
    },
    maxAnnotationLane: 1,
    maxCdsLane: -1,
    _layout: null,
    lastOverviewAggregationCacheHit: false,
    lastOverviewDensityAtlasBudgetExceeded: false,
    ...overrides,
  };
}

const path = {
  isArcMode: false,
  pixelsPerBp: 2,
  viewStartBp: 0,
  viewEndBp: 200,
} as PathMapper;

type DiagnosticsWindow = Window & { __webglDiagnosticsEnabled?: boolean };

afterEach(() => {
  delete (window as DiagnosticsWindow).__webglDiagnosticsEnabled;
});

describe('indexed annotation presentation audit', () => {
  it('beginDrawAudit increments the frame id and recordDrawAuditDecision stores pixel width', () => {
    const host = auditHost();
    const drawn = feature({ id: 7, type: 'gene', start: 10, end: 60, lane: 2 });
    const audit = beginDrawAudit(
      host,
      path,
      renderState({ zoom: 4, viewOffset: 5 }),
      [drawn],
      false,
      null
    );
    expect(host.drawAuditFrameId).toBe(4);
    expect(audit.frameId).toBe(4);
    expect(audit.renderMode).toBe('retained');
    expect(audit.renderSetLayerTypes).toEqual(['mRNA']);
    expect(audit.pixelsPerBp).toBe(2);

    const layoutHost: OverlayLayoutHost = {
      _layout: null,
      _contract: null,
      maxAnnotationLane: 0,
      maxCdsLane: 0,
      lastRenderKeyParts: null,
      genomeLength: 1_000,
      hashRetainedLinearTranscriptFeatureKey: () => 'hash',
    };
    recordDrawAuditDecision(layoutHost, audit, drawn, 'drawn', path);
    expect(audit.decisions.drawn).toBe(1);
    expect(audit.samples[0]).toMatchObject({
      id: 7,
      type: 'gene',
      start: 10,
      end: 60,
      lane: 2,
      pixelWidth: 100,
      decision: 'drawn',
    });
  });

  it('renderSetLayerTypesForAudit uses host layers only for large feature sets', () => {
    const host = {
      annotationLayerTypesForPresentation: () => ['host-mRNA'],
    };
    expect(renderSetLayerTypesForAudit(host, [], normalizeAnnotationLayerTypes)).toEqual([]);
    expect(
      renderSetLayerTypesForAudit(
        host,
        [feature({ annotationTrackId: 'mRNA', type: 'gene' }), feature({ id: 2, type: 'CDS' })],
        normalizeAnnotationLayerTypes
      )
    ).toEqual(['CDS', 'mRNA']);
    const large = { length: RETAINED_TRANSCRIPT_KEY_CACHE_MIN_FEATURES } as Feature[];
    expect(renderSetLayerTypesForAudit(host, large, normalizeAnnotationLayerTypes)).toEqual([
      'host-mRNA',
    ]);

    (window as DiagnosticsWindow).__webglDiagnosticsEnabled = false;
    const gatedHost = auditHost();
    expect(
      beginDrawAuditIfDiagnosticsEnabled(gatedHost, path, renderState(), [], false, null)
    ).toBeNull();
    expect(gatedHost.drawAuditFrameId).toBe(3);
  });
});
