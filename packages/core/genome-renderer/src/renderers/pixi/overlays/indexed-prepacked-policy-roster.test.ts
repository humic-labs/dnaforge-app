import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isCompleteRequestedPolicyAuthorityRoster,
  isPolicyLessResidentBlocking,
  residentHasPolicyPlane,
} from './indexed-prepacked-policy-roster';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('prepacked policy roster', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function residentHasPolicyPlane');
    expect(source).not.toContain('function isPolicyLessResidentBlocking');
    expect(source).not.toContain('function isCompleteRequestedPolicyAuthorityRoster');
  });

  it('requires a projection plus GPU data or a direct bank, and a lane-max table', () => {
    expect(
      residentHasPolicyPlane({
        input: { policyProjection: {}, policyGpuInstanceData: {} },
        policyTrackLaneMaxima: {},
      })
    ).toBe(true);
    expect(
      residentHasPolicyPlane({
        input: { policyProjection: {}, submissionBank: {}, submissionFineIndices: {} },
        policyTrackLaneMaxima: {},
      })
    ).toBe(true);
    expect(
      residentHasPolicyPlane({
        input: { policyProjection: {}, policyGpuInstanceData: {} },
        policyTrackLaneMaxima: undefined,
      })
    ).toBe(false);
    expect(
      residentHasPolicyPlane({
        input: { policyProjection: {} },
        policyTrackLaneMaxima: {},
      })
    ).toBe(false);
  });

  it('blocks only a selected or active policy-less resident', () => {
    expect(
      isPolicyLessResidentBlocking({
        hasPolicyPlane: false,
        isActiveLayer: true,
        isRequestedTrack: false,
      })
    ).toBe(true);
    expect(
      isPolicyLessResidentBlocking({
        hasPolicyPlane: false,
        isActiveLayer: false,
        isRequestedTrack: true,
      })
    ).toBe(true);
    expect(
      isPolicyLessResidentBlocking({
        hasPolicyPlane: false,
        isActiveLayer: false,
        isRequestedTrack: false,
      })
    ).toBe(false);
    expect(
      isPolicyLessResidentBlocking({
        hasPolicyPlane: true,
        isActiveLayer: true,
        isRequestedTrack: true,
      })
    ).toBe(false);
  });

  it('is complete when every requested track has a policy resident or a current compiled owner', () => {
    expect(
      isCompleteRequestedPolicyAuthorityRoster({
        requestedPolicyPresent: [true, false],
        compiledOwnerCurrent: [false, true],
      })
    ).toBe(true);
    expect(
      isCompleteRequestedPolicyAuthorityRoster({
        requestedPolicyPresent: [true, false],
        compiledOwnerCurrent: [false, false],
      })
    ).toBe(false);
  });
});
