import { describe, expect, it } from 'vitest';
import type { PathMapper } from '../shared/path-mapper';
import { emptyAnnotationBodyPresenterEligibility } from './annotation-body-presentation-authority';
import type { AnnotationPrebuiltRasterEligibility } from './annotation-lod-ownership';
import {
  presentExclusiveAnnotationBodyFrame,
  type ExclusiveBodyFrameHost,
} from './indexed-annotation-exclusive-body-frame';
import type { RetainedOverlayCameraState } from './overlay-track';

const ineligibleRaster: AnnotationPrebuiltRasterEligibility = {
  eligible: false,
  reason: 'unavailable',
  genomeFraction: 0,
  fillKneeSatisfied: false,
  physicalSamplingSatisfied: false,
};

function camera(): RetainedOverlayCameraState {
  return {
    path: { viewStartBp: 0, viewEndBp: 1_000 } as PathMapper,
    state: {
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
    },
    yOffset: 0,
    height: 200,
  };
}

function frameHost(overrides: Partial<ExclusiveBodyFrameHost> = {}): ExclusiveBodyFrameHost {
  return {
    maxAnnotationLane: 0,
    prepackedAnnotationRuntimePolicy: null,
    annotationBodyFrameEligibility: emptyAnnotationBodyPresenterEligibility(),
    annotationLayerTypesForPresentation: () => ['mRNA'],
    tryPresentRequestedCompiledBroadSurfaces() {
      return 'absent';
    },
    noteAnnotationBodyFrameOwner() {},
    probeAnnotationBodyPresenterEligibility() {
      return emptyAnnotationBodyPresenterEligibility();
    },
    tryPresentPrepackedAnnotationScene() {
      return 'absent';
    },
    tilePyramid: {
      tryPresent() {
        return false;
      },
    },
    tilePyramidHost() {
      return {};
    },
    finalizeCompiledAnnotationBodyPresent() {},
    tryPresentPrebuiltRasterBody() {
      return false;
    },
    tryRetainLastCompleteCompiledBroadSurfaceFrame() {
      return false;
    },
    ...overrides,
  };
}

describe('indexed annotation exclusive body frame', () => {
  it('lets the first complete owner win and does not call later owners', () => {
    const called: string[] = [];
    const host = frameHost({
      tryPresentRequestedCompiledBroadSurfaces() {
        called.push('compiled');
        return 'complete';
      },
      noteAnnotationBodyFrameOwner(owner) {
        called.push(`owner:${owner}`);
      },
      probeAnnotationBodyPresenterEligibility() {
        called.push('probe');
        return emptyAnnotationBodyPresenterEligibility();
      },
      tryPresentPrepackedAnnotationScene() {
        called.push('prepacked');
        return 'absent';
      },
      tilePyramid: {
        tryPresent() {
          called.push('tile');
          return false;
        },
      },
      tryPresentPrebuiltRasterBody() {
        called.push('raster');
        return false;
      },
      tryRetainLastCompleteCompiledBroadSurfaceFrame() {
        called.push('retain');
        return false;
      },
    });
    expect(
      presentExclusiveAnnotationBodyFrame(host, camera(), 'retained', ineligibleRaster, false)
    ).toBe(true);
    expect(called).toEqual(['compiled', 'owner:compiled-broad']);
  });

  it('falls through to prepacked when compiled-broad is absent and skips later owners', () => {
    const called: string[] = [];
    const host = frameHost({
      tryPresentRequestedCompiledBroadSurfaces() {
        called.push('compiled');
        return 'absent';
      },
      probeAnnotationBodyPresenterEligibility() {
        called.push('probe');
        return emptyAnnotationBodyPresenterEligibility();
      },
      tryPresentPrepackedAnnotationScene() {
        called.push('prepacked');
        return 'complete';
      },
      noteAnnotationBodyFrameOwner(owner) {
        called.push(`owner:${owner}`);
      },
      tilePyramid: {
        tryPresent() {
          called.push('tile');
          return false;
        },
      },
      tryPresentPrebuiltRasterBody() {
        called.push('raster');
        return false;
      },
      tryRetainLastCompleteCompiledBroadSurfaceFrame() {
        called.push('retain');
        return false;
      },
    });
    expect(
      presentExclusiveAnnotationBodyFrame(host, camera(), 'retained', ineligibleRaster, false)
    ).toBe(true);
    expect(called).toEqual(['compiled', 'probe', 'prepacked', 'owner:prepacked-vector']);
  });

  it('holds the last complete compiled-broad frame when replacement is pending', () => {
    const called: string[] = [];
    const host = frameHost({
      tryPresentRequestedCompiledBroadSurfaces() {
        called.push('compiled');
        return 'pending';
      },
      probeAnnotationBodyPresenterEligibility() {
        called.push('probe');
        return emptyAnnotationBodyPresenterEligibility();
      },
      tryPresentPrepackedAnnotationScene() {
        called.push('prepacked');
        return 'absent';
      },
      tryRetainLastCompleteCompiledBroadSurfaceFrame() {
        called.push('retain');
        return true;
      },
      noteAnnotationBodyFrameOwner(owner) {
        called.push(`owner:${owner}`);
      },
    });
    expect(
      presentExclusiveAnnotationBodyFrame(host, camera(), 'retained', ineligibleRaster, true)
    ).toBe(true);
    expect(called).toEqual(['compiled', 'probe', 'prepacked', 'retain', 'owner:compiled-broad']);
  });

  it('returns false when every owner is absent and nothing is held', () => {
    expect(
      presentExclusiveAnnotationBodyFrame(
        frameHost(),
        camera(),
        'retained',
        ineligibleRaster,
        false
      )
    ).toBe(false);
  });

  it('does not hold compiled-broad when pending without a prior complete frame', () => {
    const called: string[] = [];
    const host = frameHost({
      tryPresentRequestedCompiledBroadSurfaces() {
        called.push('compiled');
        return 'pending';
      },
      probeAnnotationBodyPresenterEligibility() {
        called.push('probe');
        return emptyAnnotationBodyPresenterEligibility();
      },
      tryPresentPrepackedAnnotationScene() {
        called.push('prepacked');
        return 'absent';
      },
      tryRetainLastCompleteCompiledBroadSurfaceFrame() {
        called.push('retain');
        return true;
      },
      noteAnnotationBodyFrameOwner(owner) {
        called.push(`owner:${owner}`);
      },
    });
    expect(
      presentExclusiveAnnotationBodyFrame(host, camera(), 'retained', ineligibleRaster, false)
    ).toBe(false);
    expect(called).toEqual(['compiled', 'probe', 'prepacked']);
  });
});
