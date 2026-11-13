import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PREPACKED_TRANSCRIPT_FINE_PREWARM_MAX_SPAN_BP } from '../overview/partitioned-instanced-transcript-layer';
import {
  clampPrepackedFinePrewarmViewport,
  countPrepackedFinePreparationPending,
  nextPrepackedFinePreparationAction,
} from './indexed-prepacked-fine-prewarm';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('clampPrepackedFinePrewarmViewport', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function clampPrepackedFinePrewarmViewport');
    expect(source).not.toContain('function nextPrepackedFinePreparationAction');
    expect(source).not.toContain('function countPrepackedFinePreparationPending');
  });

  it('rejects a span wider than the fine-prewarm corridor', () => {
    expect(
      clampPrepackedFinePrewarmViewport({
        viewportStartBp: 0,
        viewportEndBp: PREPACKED_TRANSCRIPT_FINE_PREWARM_MAX_SPAN_BP + 1,
        genomeLengthBp: PREPACKED_TRANSCRIPT_FINE_PREWARM_MAX_SPAN_BP * 4,
      })
    ).toBeNull();
  });

  it('rejects an empty or inverted span after clamping', () => {
    expect(
      clampPrepackedFinePrewarmViewport({
        viewportStartBp: 100,
        viewportEndBp: 100,
        genomeLengthBp: 1_000,
      })
    ).toBeNull();
    expect(
      clampPrepackedFinePrewarmViewport({
        viewportStartBp: 200,
        viewportEndBp: 50,
        genomeLengthBp: 1_000,
      })
    ).toBeNull();
  });

  it('clamps a valid camera into integer genome bounds', () => {
    expect(
      clampPrepackedFinePrewarmViewport({
        viewportStartBp: -12.7,
        viewportEndBp: 512.2,
        genomeLengthBp: 10_000,
      })
    ).toEqual({
      startBp: 0,
      endBp: 513,
      visibleBp: 513,
    });
  });
});

function resident(overrides: {
  ownerKey: string;
  gpu?: boolean;
  fine?: boolean;
  coarse?: boolean;
}) {
  return {
    ownerKey: overrides.ownerKey,
    layer: {
      isGpuPrepared: overrides.gpu ?? true,
      isCoarseFallbackPrepared: overrides.coarse ?? true,
      areFineViewsPrewarmed: () => overrides.fine ?? true,
    },
  };
}

describe('nextPrepackedFinePreparationAction', () => {
  it('waits when the renderer is not WebGL or a selected resident is missing', () => {
    expect(
      nextPrepackedFinePreparationAction({
        hasWebglRenderer: false,
        residents: [resident({ ownerKey: 'a' })],
        startBp: 0,
        endBp: 100,
      })
    ).toEqual({ kind: 'waiting-residents' });
    expect(
      nextPrepackedFinePreparationAction({
        hasWebglRenderer: true,
        residents: [resident({ ownerKey: 'a' }), undefined],
        startBp: 0,
        endBp: 100,
      })
    ).toEqual({ kind: 'waiting-residents' });
    expect(
      nextPrepackedFinePreparationAction({
        hasWebglRenderer: true,
        residents: [],
        startBp: 0,
        endBp: 100,
      })
    ).toEqual({ kind: 'waiting-residents' });
  });

  it('prepares GPU first, then fine views, then coarse fallback', () => {
    const gpu = resident({ ownerKey: 'gpu', gpu: false, fine: false, coarse: false });
    expect(
      nextPrepackedFinePreparationAction({
        hasWebglRenderer: true,
        residents: [gpu, resident({ ownerKey: 'ready' })],
        startBp: 0,
        endBp: 100,
      })
    ).toEqual({ kind: 'prepare-gpu', resident: gpu });

    const fine = resident({ ownerKey: 'fine', fine: false, coarse: false });
    expect(
      nextPrepackedFinePreparationAction({
        hasWebglRenderer: true,
        residents: [resident({ ownerKey: 'ready' }), fine],
        startBp: 0,
        endBp: 100,
      })
    ).toEqual({ kind: 'prewarm-fine', resident: fine });

    const coarse = resident({ ownerKey: 'coarse', coarse: false });
    expect(
      nextPrepackedFinePreparationAction({
        hasWebglRenderer: true,
        residents: [resident({ ownerKey: 'ready' }), coarse],
        startBp: 0,
        endBp: 100,
      })
    ).toEqual({ kind: 'prepare-coarse', resident: coarse });
  });

  it('reports complete only when every selected resident is GPU, fine, and coarse ready', () => {
    expect(
      nextPrepackedFinePreparationAction({
        hasWebglRenderer: true,
        residents: [resident({ ownerKey: 'a' }), resident({ ownerKey: 'b' })],
        startBp: 0,
        endBp: 100,
      })
    ).toEqual({ kind: 'complete' });
  });
});

describe('countPrepackedFinePreparationPending', () => {
  it('includes GPU debt only on the GPU-preparation path', () => {
    const residents = [
      resident({ ownerKey: 'gpu', gpu: false, fine: true, coarse: true }),
      resident({ ownerKey: 'fine', fine: false, coarse: true }),
    ];
    expect(
      countPrepackedFinePreparationPending({
        residents,
        startBp: 0,
        endBp: 100,
        includeGpu: true,
      })
    ).toBe(2);
    expect(
      countPrepackedFinePreparationPending({
        residents,
        startBp: 0,
        endBp: 100,
        includeGpu: false,
      })
    ).toBe(1);
  });
});
