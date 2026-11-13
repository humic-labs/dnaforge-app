import { describe, expect, it } from 'vitest';

import {
  buildAnnotationDrawAudit,
  recordAnnotationDrawAuditDecision,
  snapshotAnnotationDrawAudit,
} from './annotation-draw-audit';
import type { PathMapper } from '../shared/path-mapper';
import type { RenderState } from '../../../types';

describe('annotation draw audit', () => {
  it('builds a zeroed audit snapshot from path, state, layout, and overview diagnostics', () => {
    const audit = buildAnnotationDrawAudit({
      frameId: 7,
      renderMode: 'retained',
      path: {
        isArcMode: false,
        pixelsPerBp: 0.25,
        viewStartBp: 10,
        viewEndBp: 50,
      } as PathMapper,
      state: { zoom: 2, viewOffset: 3, height: 100 } as RenderState,
      featureCount: 11,
      renderSetFeatureCount: 4,
      maxAnnotationLane: 2,
      maxCdsLane: 0,
      layout: null,
      overviewAggregationEnabled: true,
      overviewCache: {
        binBp: 1024,
        binCount: 3,
        passthroughFeatureCount: 2,
        diagnostics: {
          inputFeatureCount: 8,
          skippedMinVisibleFeatureCount: 1,
          aggregateWideFeatureCount: 2,
          aggregatedFeatureCount: 5,
          binContributionCount: 13,
        },
      },
      overviewCacheHit: true,
      overviewBudgetExceeded: false,
    });

    expect(audit.frameId).toBe(7);
    expect(audit.pathMode).toBe('linear');
    expect(audit.decisions.drawn).toBe(0);
    expect(audit.layout.annotationLanes).toBe(3);
    expect(audit.layout.cdsLanes).toBe(1);
    expect(audit.overview).toMatchObject({
      aggregationEnabled: true,
      cacheHit: true,
      binBp: 1024,
      binCount: 3,
      passthroughFeatureCount: 2,
      atlasInputFeatureCount: 8,
      atlasBinContributionCount: 13,
    });
  });

  it('records decisions and caps samples', () => {
    const audit = buildAnnotationDrawAudit({
      frameId: 1,
      renderMode: 'rebuild',
      path: {
        isArcMode: true,
        pixelsPerBp: 1,
        viewStartBp: 0,
        viewEndBp: 10,
      } as PathMapper,
      state: { zoom: 1, viewOffset: 0, height: 100 } as RenderState,
      featureCount: 1,
      renderSetFeatureCount: 1,
      maxAnnotationLane: 0,
      maxCdsLane: -1,
      layout: null,
      overviewAggregationEnabled: false,
      overviewCache: null,
      overviewCacheHit: false,
      overviewBudgetExceeded: false,
    });

    for (let i = 0; i < 100; i += 1) {
      recordAnnotationDrawAuditDecision(audit, {
        id: i,
        type: 'gene',
        start: i,
        end: i + 1,
        lane: 0,
        cdsLane: null,
        pixelWidth: 1,
        decision: 'drawn',
      });
    }

    expect(audit.decisions.drawn).toBe(100);
    expect(audit.samples).toHaveLength(80);
  });

  it('reuses the renderer-owned buffer while returned snapshots remain stable', () => {
    const input = {
      frameId: 1,
      renderMode: 'rebuild' as const,
      path: {
        isArcMode: false,
        pixelsPerBp: 1,
        viewStartBp: 0,
        viewEndBp: 10,
      } as PathMapper,
      state: { zoom: 1, viewOffset: 0, height: 100 } as RenderState,
      featureCount: 1,
      renderSetFeatureCount: 1,
      renderSetLayerTypes: ['mRNA'],
      maxAnnotationLane: 0,
      maxCdsLane: -1,
      layout: null,
      overviewAggregationEnabled: false,
      overviewCache: null,
      overviewCacheHit: false,
      overviewBudgetExceeded: false,
    };
    const buffer = buildAnnotationDrawAudit(input);
    recordAnnotationDrawAuditDecision(buffer, {
      id: 1,
      type: 'mRNA',
      start: 0,
      end: 10,
      lane: 0,
      cdsLane: null,
      pixelWidth: 10,
      decision: 'drawn',
    });
    const published = snapshotAnnotationDrawAudit(buffer);

    const reused = buildAnnotationDrawAudit(
      {
        ...input,
        frameId: 2,
        path: { ...input.path, viewStartBp: 10, viewEndBp: 20 } as PathMapper,
        renderSetLayerTypes: ['gene'],
      },
      buffer
    );

    expect(reused).toBe(buffer);
    expect(reused.frameId).toBe(2);
    expect(reused.viewStartBp).toBe(10);
    expect(reused.renderSetLayerTypes).toEqual(['gene']);
    expect(reused.decisions.drawn).toBe(0);
    expect(reused.samples).toEqual([]);
    expect(published).toMatchObject({
      frameId: 1,
      viewStartBp: 0,
      renderSetLayerTypes: ['mRNA'],
      decisions: { drawn: 1 },
    });
    expect(published.samples).toHaveLength(1);
  });
});
