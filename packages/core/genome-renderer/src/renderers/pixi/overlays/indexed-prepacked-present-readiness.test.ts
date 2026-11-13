import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  planPrepackedPresentAfterResidents,
  prepackedFineSelectionIsExact,
} from './indexed-prepacked-present-readiness';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

type Resident = {
  ownerKey: string;
  policyGeneration: number;
  barHeight: number;
  covers: boolean;
  needsFine: boolean;
};

function resident(partial: Partial<Resident> & { ownerKey: string }): Resident {
  return {
    policyGeneration: 1,
    barHeight: 8,
    covers: true,
    needsFine: false,
    ...partial,
  };
}

function plan(
  overrides: Partial<Parameters<typeof planPrepackedPresentAfterResidents<Resident>>[0]> = {}
) {
  const residents = overrides.residents ?? [resident({ ownerKey: 'a' })];
  return planPrepackedPresentAfterResidents({
    residents,
    holdingLastComplete: false,
    lastCompleteResidents: null,
    policyGeneration: 1,
    residentPolicyGeneration: (item) => item.policyGeneration,
    visibleBp: 1000,
    scaledBarHeightPx: 8,
    residentBarHeightPx: (item) => item.barHeight,
    annotationTrackBase: 12,
    coversViewport: (item) => item.covers,
    needsFinePreparation: (item) => item.needsFine,
    ...overrides,
  });
}

describe('planPrepackedPresentAfterResidents', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function planPrepackedPresentAfterResidents');
    expect(source).not.toContain('function prepackedFineSelectionIsExact');
  });

  it('rejects empty, stale-policy, invalid-span, bar-height, and missing-track-base rosters', () => {
    expect(plan({ residents: [] })).toEqual({ kind: 'absent' });
    expect(plan({ residents: [resident({ ownerKey: 'a', policyGeneration: 2 })] })).toEqual({
      kind: 'status-absent',
      status: 'variant-mismatch',
    });
    expect(plan({ visibleBp: 0 })).toEqual({
      kind: 'status-absent',
      status: 'outside-corridor',
    });
    expect(plan({ residents: [resident({ ownerKey: 'a', barHeight: 4 })] })).toEqual({
      kind: 'dispose-absent',
      status: 'variant-mismatch',
    });
    expect(plan({ annotationTrackBase: null })).toEqual({
      kind: 'status-absent',
      status: 'variant-mismatch',
    });
  });

  it('holds last-complete when the desired roster still needs fine views', () => {
    const desired = resident({ ownerKey: 'next', needsFine: true });
    const lastComplete = [resident({ ownerKey: 'prev' })];
    expect(
      plan({
        residents: [desired],
        lastCompleteResidents: lastComplete,
      })
    ).toEqual({
      kind: 'present',
      residents: lastComplete,
      holdingLastComplete: true,
    });
  });

  it('hides and waits when coverage or fine views are incomplete and last-complete cannot hold', () => {
    expect(plan({ residents: [resident({ ownerKey: 'a', covers: false })] })).toEqual({
      kind: 'pending',
      status: 'fine-view-pending',
      reason: 'viewport-coverage',
    });
    expect(plan({ residents: [resident({ ownerKey: 'a', needsFine: true })] })).toEqual({
      kind: 'hide-pending',
      status: 'fine-view-pending',
      reason: 'fine-views-not-prewarmed',
    });
  });
});

describe('prepackedFineSelectionIsExact', () => {
  it('allows coarse presentation and rejects inexact fine selection', () => {
    expect(
      prepackedFineSelectionIsExact({
        requiresFinePresentation: false,
        isFinePresentationExact: false,
      })
    ).toBe(true);
    expect(
      prepackedFineSelectionIsExact({
        requiresFinePresentation: true,
        isFinePresentationExact: true,
      })
    ).toBe(true);
    expect(
      prepackedFineSelectionIsExact({
        requiresFinePresentation: true,
        isFinePresentationExact: false,
      })
    ).toBe(false);
  });
});
