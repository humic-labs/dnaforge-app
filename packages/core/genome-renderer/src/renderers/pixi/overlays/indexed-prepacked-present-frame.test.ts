import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  presentPrepackedAnnotationScene,
  type PrepackedPresentFrameHost,
  type PrepackedPresentResident,
} from './indexed-prepacked-present-frame';
import type { RetainedOverlayCameraState } from './overlay-track';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function camera(viewStartBp = 0, viewEndBp = 1000): RetainedOverlayCameraState {
  return {
    path: {
      viewStartBp,
      viewEndBp,
    },
    state: {
      width: 800,
      height: 200,
      themeMode: 'light',
    },
  } as RetainedOverlayCameraState;
}

function scene(): PrepackedPresentResident['input']['scene'] {
  return {
    primitives: [{ kind: 'block' }],
    families: [{ kind: 'transcript' }],
  } as unknown as PrepackedPresentResident['input']['scene'];
}

function resident(
  partial: Partial<PrepackedPresentResident> & { ownerKey: string }
): PrepackedPresentResident {
  return {
    lastUsed: 1,
    policyGeneration: 1,
    viewportDetailPresentationAdmitted: true,
    visiblePartitionCount: 0,
    visibleInstanceCount: 0,
    metadata: {
      trackType: 'mRNA',
      themeMode: 'light',
      annotationBarHeightPx: 8,
    },
    input: {
      scene: scene(),
      gpuReadyScene: { featureIndices: { length: 1 } },
    },
    layer: {
      isFinePresentationExact: true,
      requiresFinePresentationForViewport: () => false,
      areFineViewsPrewarmed: () => true,
      updateVisibleRange: () => [{ instanceCount: 3 }],
      updateCamera: () => undefined,
      hide: () => undefined,
      show: () => undefined,
    },
    ...partial,
  };
}

function host(
  overrides: Partial<PrepackedPresentFrameHost> & {
    bank?: PrepackedPresentResident[];
    replacements?: PrepackedPresentResident[];
  } = {}
): PrepackedPresentFrameHost & {
  status: string | null;
  fineReason: string | null;
  sealed: boolean;
  lastPresentation: unknown;
} {
  const bank = overrides.bank ?? [];
  const replacements = overrides.replacements ?? [];
  const residentMap = new Map(bank.map((entry) => [entry.ownerKey, entry]));
  const frame: PrepackedPresentFrameHost & {
    status: string | null;
    fineReason: string | null;
    sealed: boolean;
    lastPresentation: unknown;
  } = {
    genomeLength: 5000,
    requestedLayerTypes: ['mRNA'],
    ownerKey: bank[0]?.ownerKey ?? null,
    policyGeneration: 1,
    lastCompleteOwnerKeys: bank.map(({ ownerKey }) => ownerKey),
    residentsSize: bank.length,
    candidatesSize: replacements.length,
    scaledBarHeightPx: 8,
    annotationTrackBase: 12,
    runtimePolicy: { isoformMode: 'canonical', laneLimit: 4 },
    maxAnnotationLane: 3,
    replacementCandidates: replacements,
    residents: bank,
    getResident: (ownerKey) => residentMap.get(ownerKey),
    compiledOwnerForTrack: () => null,
    laneStart: () => 0,
    status: null,
    fineReason: null,
    sealed: false,
    lastPresentation: null,
    setFinePendingReason(reason) {
      frame.fineReason = reason;
    },
    setStatus(status) {
      frame.status = status;
    },
    disposeScene(status) {
      frame.status = `dispose:${status}`;
    },
    hideResident(item) {
      item.layer.hide();
      item.visiblePartitionCount = 0;
      item.visibleInstanceCount = 0;
    },
    setVisibleCounts: () => undefined,
    incrementCameraUpdates: () => undefined,
    commitReplacement: () => undefined,
    setLastPresentation(presentation) {
      frame.lastPresentation = presentation;
    },
    setLastCompleteOwnerKeys: () => undefined,
    cdsDetailProgress: () => 0,
    sealPresentedFrame() {
      frame.sealed = true;
    },
    ...overrides,
  };
  return frame;
}

describe('presentPrepackedAnnotationScene', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function presentPrepackedAnnotationScene');
    expect(source).not.toContain('const residentForCommittedTrack =');
  });

  it('exports the present entry point for the overlay façade', () => {
    expect(typeof presentPrepackedAnnotationScene).toBe('function');
  });

  it('stays absent while the prebuilt raster already owns overview', () => {
    const frame = host();
    expect(presentPrepackedAnnotationScene(frame, camera(), 'retained', { eligible: true })).toBe(
      'absent'
    );
    expect(frame.status).toBe('eligible');
    expect(frame.sealed).toBe(false);
  });

  it('holds mixed-layer pending when any requested track is missing and last-complete cannot resolve', () => {
    const existing = resident({
      ownerKey: 'gene',
      metadata: {
        trackType: 'gene',
        themeMode: 'light',
        annotationBarHeightPx: 8,
      },
    });
    const frame = host({
      bank: [existing],
      requestedLayerTypes: ['mRNA'],
      lastCompleteOwnerKeys: ['missing'],
      residentsSize: 1,
      getResident: () => undefined,
    });
    expect(presentPrepackedAnnotationScene(frame, camera(), 'retained', { eligible: false })).toBe(
      'pending'
    );
    expect(frame.status).toBe('mixed-layer-fallback');
  });

  it('presents a complete admitted roster and seals the frame', () => {
    const presenting = resident({ ownerKey: 'mrna' });
    const frame = host({ bank: [presenting] });
    expect(presentPrepackedAnnotationScene(frame, camera(), 'retained', { eligible: false })).toBe(
      'complete'
    );
    expect(frame.status).toBe('eligible');
    expect(frame.sealed).toBe(true);
    expect(presenting.visibleInstanceCount).toBe(3);
    expect(frame.lastPresentation).toMatchObject({
      viewportStartBp: 0,
      viewportEndBp: 1000,
      themeMode: 'light',
    });
  });

  it('does not bind an exact detail resident to a case-only compiled-owner alias', () => {
    const lower = resident({
      ownerKey: 'owner-Dm88',
      metadata: {
        trackType: 'transposon:Dm88',
        themeMode: 'light',
        annotationBarHeightPx: 8,
      },
    });
    const upper = resident({
      ownerKey: 'owner-DM88',
      metadata: {
        trackType: 'transposon:DM88',
        themeMode: 'light',
        annotationBarHeightPx: 8,
      },
    });
    const caseOnlyAlias = {
      provenance: {
        themeMode: 'light',
        prepackedOwnerKey: lower.ownerKey,
      },
      manifest: {
        trackId: lower.metadata.trackType,
        laneRowCssHeightPx: 8,
      },
    };
    const frame = host({
      bank: [lower, upper],
      ownerKey: null,
      requestedLayerTypes: [lower.metadata.trackType, upper.metadata.trackType],
      compiledOwnerForTrack: () => caseOnlyAlias,
    });

    expect(presentPrepackedAnnotationScene(frame, camera(), 'retained', { eligible: false })).toBe(
      'complete'
    );
    expect(frame.status).toBe('eligible');
    expect(frame.sealed).toBe(true);
    expect(lower.visibleInstanceCount).toBe(3);
    expect(upper.visibleInstanceCount).toBe(3);
  });
});
