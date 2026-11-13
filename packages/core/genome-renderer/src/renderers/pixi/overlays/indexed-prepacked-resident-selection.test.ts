import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  sameViewportDetailPresentationLease,
  selectAnnotationPresentationResident,
} from './indexed-prepacked-resident-selection';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function detail(start = 10, end = 20) {
  return {
    packetPayloadSha256: 'pkt',
    sourceFingerprint: 'src',
    interactionPayloadSha256: 'ix',
    coverageStartBp: start,
    coverageEndBp: end,
    handoffStartBp: start,
    handoffEndBp: end,
    empty: false,
  };
}

function resident(overrides: {
  ownerKey: string;
  lastUsed: number;
  trackType?: string;
  themeMode?: 'light' | 'dark';
  policyGeneration?: number;
  admitted?: boolean;
  coverageStartBp?: number;
  coverageEndBp?: number;
}) {
  return {
    ownerKey: overrides.ownerKey,
    lastUsed: overrides.lastUsed,
    policyGeneration: overrides.policyGeneration ?? 1,
    viewportDetailPresentationAdmitted: overrides.admitted ?? true,
    metadata: {
      trackType: overrides.trackType ?? 'mRNA',
      themeMode: overrides.themeMode ?? 'light',
    },
    input: {
      viewportDetail: detail(overrides.coverageStartBp ?? 0, overrides.coverageEndBp ?? 1_000),
    },
  };
}

describe('indexed prepacked resident selection', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function sameViewportDetailPresentationLease');
    expect(source).not.toContain('function selectAnnotationPresentationResident');
  });

  it('treats identical viewport-detail leases as the same physical packet', () => {
    const left = detail();
    expect(sameViewportDetailPresentationLease(left, { ...left })).toBe(true);
    expect(sameViewportDetailPresentationLease(left, detail(11, 20))).toBe(false);
    expect(sameViewportDetailPresentationLease(left, undefined)).toBe(false);
  });

  it('picks the newest admitted resident that covers the camera', () => {
    const older = resident({
      ownerKey: 'old',
      lastUsed: 1,
      coverageStartBp: 0,
      coverageEndBp: 100,
    });
    const newer = resident({
      ownerKey: 'new',
      lastUsed: 9,
      coverageStartBp: 0,
      coverageEndBp: 100,
    });
    const otherTrack = resident({ ownerKey: 'gene', lastUsed: 99, trackType: 'gene' });
    expect(
      selectAnnotationPresentationResident({
        residents: [older, newer, otherTrack],
        trackType: 'mRNA',
        themeMode: 'light',
        policyGeneration: 1,
        viewportStartBp: 10,
        viewportEndBp: 20,
      })?.ownerKey
    ).toBe('new');
  });

  it('selects case-distinct scientific residents exactly and rejects an ambiguous alias', () => {
    const lower = resident({
      ownerKey: 'lower',
      lastUsed: 1,
      trackType: 'transposon:Dm88',
    });
    const upper = resident({
      ownerKey: 'upper',
      lastUsed: 2,
      trackType: 'transposon:DM88',
    });
    const input = {
      residents: [lower, upper],
      themeMode: 'light' as const,
      policyGeneration: 1,
      viewportStartBp: 10,
      viewportEndBp: 20,
    };

    expect(
      selectAnnotationPresentationResident({ ...input, trackType: 'transposon:Dm88' })?.ownerKey
    ).toBe('lower');
    expect(
      selectAnnotationPresentationResident({ ...input, trackType: 'transposon:DM88' })?.ownerKey
    ).toBe('upper');
    expect(
      selectAnnotationPresentationResident({ ...input, trackType: 'transposon:dm88' })
    ).toBeUndefined();
  });
});
