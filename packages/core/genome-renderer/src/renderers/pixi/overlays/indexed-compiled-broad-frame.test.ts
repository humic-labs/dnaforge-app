import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCompiledBroadSteadyRoster,
  compiledBroadTrackTopCssPx,
  isCompiledBroadSteadyOwnerCurrent,
  isCompiledBroadSteadyRosterReusable,
  presentRequestedCompiledBroadSurfaces,
  retainLastCompleteCompiledBroadSurfaceFrame,
} from './indexed-compiled-broad-frame';
import type { CompiledBroadSurfaceTrackOwnerV2 } from './indexed-compiled-broad-frame';
import type { RetainedOverlayCameraState } from './overlay-track';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('compiled-broad frame presenter', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function presentRequestedCompiledBroadSurfaces');
    expect(source).not.toContain('function presentCommittedCompiledBroadSurfaceRoster');
    expect(source).not.toContain('function retainLastCompleteCompiledBroadSurfaceFrame');
    expect(source).not.toContain('function buildCompiledBroadSteadyRoster');
    expect(source).not.toContain('function compiledBroadTrackTopCssPx');
  });

  it('places a track from the spine, half-row, and lane start', () => {
    expect(
      compiledBroadTrackTopCssPx({
        fwdStrandTop: 100,
        layoutAnnotationOffset: 20,
        laneRowCssHeightPx: 16,
        laneStart: 2,
      })
    ).toBe(100 + 20 - 8 - 32);
  });

  it('treats the active presenter as current only when manifest and provenance match', () => {
    const presenter = { id: 'p' };
    const manifest = { id: 'm' };
    const provenance = { id: 'pr' };
    const owner = { presenter, manifest, provenance } as never;
    expect(
      isCompiledBroadSteadyOwnerCurrent({
        owner,
        activePresenter: presenter as never,
        activeManifest: manifest as never,
        activeProvenance: provenance as never,
        registeredOwner: owner,
      })
    ).toBe(true);
    expect(
      isCompiledBroadSteadyOwnerCurrent({
        owner,
        activePresenter: presenter as never,
        activeManifest: { id: 'other' } as never,
        activeProvenance: provenance as never,
        registeredOwner: owner,
      })
    ).toBe(false);
  });

  it('reuses a steady roster only when identity, policy, and candidate banks match', () => {
    const requestedLayerTypes: readonly string[] = [];
    const roster = buildCompiledBroadSteadyRoster({
      requestedLayerTypes,
      requestedThemeMode: 'light',
      policy: { isoformMode: 'canonical', laneLimit: 4 },
      sourceFingerprint: 'src',
      placementFingerprint: 'place',
      rows: [],
    });
    const base = {
      roster,
      requestedLayerTypes,
      requestedThemeMode: 'light' as const,
      policy: { isoformMode: 'canonical' as const, laneLimit: 4 },
      sourceFingerprint: 'src',
      placementFingerprint: 'place',
      hasLayout: true,
      hasCandidatePresenter: false,
      candidateOwnerCount: 0,
    };
    expect(isCompiledBroadSteadyRosterReusable(base)).toBe(true);
    expect(isCompiledBroadSteadyRosterReusable({ ...base, hasLayout: false })).toBe(false);
    expect(isCompiledBroadSteadyRosterReusable({ ...base, candidateOwnerCount: 1 })).toBe(false);
    expect(isCompiledBroadSteadyRosterReusable({ ...base, sourceFingerprint: 'other' })).toBe(
      false
    );
  });

  it('exports the present and retain entry points for the overlay façade', () => {
    expect(typeof presentRequestedCompiledBroadSurfaces).toBe('function');
    expect(typeof retainLastCompleteCompiledBroadSurfaceFrame).toBe('function');
  });

  it('keeps the committed broad presenter visible while a detail replacement is pending', () => {
    const hide = vi.fn();
    const presenter = { hide };
    const manifest = { genomeLengthBp: 10_000 };
    const provenance = {};
    const owner = {
      manifest,
      provenance,
      presenter,
    } as unknown as CompiledBroadSurfaceTrackOwnerV2;
    const host = {
      genomeLength: 10_000,
      hasLayout: true,
      layoutAnnotationOffset: 0,
      devicePixelRatio: 1,
      requirement: { genomeLengthBp: 10_000, broadCorridorFinestSpanBp: 1_000 },
      hasPresenter: true,
      hasCandidatePresenter: false,
      trackOwnerCount: 1,
      candidateOwnerCount: 0,
      runtimePolicy: { isoformMode: 'canonical', laneLimit: 1 },
      maxAnnotationLane: 0,
      sourceFingerprint: null,
      placementFingerprint: null,
      steadyRoster: null,
      lastCompleteTrackIds: ['mRNA'],
      linearContract: {},
      fastCamera: {},
      activePresenter: presenter,
      activeManifest: manifest,
      activeProvenance: provenance,
      recordCameraRequest: vi.fn(),
      ownerRosterForTheme: vi.fn(() => [
        { trackId: 'mRNA', currentOwner: owner, candidateOwner: null, owner },
      ]),
      laneStart: vi.fn(() => 0),
      provenanceIsCurrent: vi.fn(() => true),
      candidateRegistrationMatches: vi.fn(() => true),
      finalizeCandidateOwner: vi.fn(),
      ownerForTrack: vi.fn(() => owner),
      registeredTrackOwner: vi.fn(() => owner),
      incrementPlanDerivationCount: vi.fn(),
      setPlanStatus: vi.fn(),
      setOwnedLastFrame: vi.fn(),
      setSteadyRoster: vi.fn(),
      setLastCompleteTrackIds: vi.fn(),
      sealPresentedFrame: vi.fn(() => true),
    } as never;
    const camera = {
      path: { viewStartBp: 0, viewEndBp: 1_000, fwdStrandTop: 0 },
      state: { width: 800, height: 400 },
    } as RetainedOverlayCameraState;

    expect(presentRequestedCompiledBroadSurfaces(host, camera, ['mRNA'])).toBe('pending');
    expect(hide).not.toHaveBeenCalled();
  });

  it('retires broad presenters outside the requested roster only after the successor is ready', () => {
    const requestedPresenter = {
      updateCameraWithinActiveTopology: vi.fn(() => true),
    };
    const owner = {
      manifest: { genomeLengthBp: 10_000, laneRowCssHeightPx: 14 },
      provenance: {},
      presenter: requestedPresenter,
    } as unknown as CompiledBroadSurfaceTrackOwnerV2;
    const retirePresentersOutsideRoster = vi.fn();
    const host = {
      genomeLength: 10_000,
      hasLayout: true,
      layoutAnnotationOffset: 0,
      devicePixelRatio: 1,
      requirement: null,
      hasPresenter: true,
      hasCandidatePresenter: false,
      trackOwnerCount: 4,
      candidateOwnerCount: 0,
      runtimePolicy: { isoformMode: 'canonical', laneLimit: 1 },
      maxAnnotationLane: 0,
      sourceFingerprint: null,
      placementFingerprint: null,
      steadyRoster: null,
      lastCompleteTrackIds: ['mRNA', 'lnc_RNA', 'enhancer', 'silencer'],
      linearContract: {},
      fastCamera: {},
      activePresenter: requestedPresenter,
      activeManifest: owner.manifest,
      activeProvenance: owner.provenance,
      recordCameraRequest: vi.fn(),
      ownerRosterForTheme: vi.fn(() => [
        { trackId: 'mRNA', currentOwner: owner, candidateOwner: null, owner },
      ]),
      laneStart: vi.fn(() => 0),
      provenanceIsCurrent: vi.fn(() => true),
      candidateRegistrationMatches: vi.fn(() => true),
      finalizeCandidateOwner: vi.fn(),
      retirePresentersOutsideRoster,
      ownerForTrack: vi.fn(() => owner),
      registeredTrackOwner: vi.fn(() => owner),
      incrementPlanDerivationCount: vi.fn(),
      setPlanStatus: vi.fn(),
      setOwnedLastFrame: vi.fn(),
      setSteadyRoster: vi.fn(),
      setLastCompleteTrackIds: vi.fn(),
      sealPresentedFrame: vi.fn(() => true),
    } as never;
    const camera = {
      path: { viewStartBp: 0, viewEndBp: 1_000, fwdStrandTop: 0 },
      state: { width: 800, height: 400 },
    } as RetainedOverlayCameraState;

    expect(presentRequestedCompiledBroadSurfaces(host, camera, ['mRNA'])).toBe('complete');
    expect(retirePresentersOutsideRoster).toHaveBeenCalledOnce();
    expect(retirePresentersOutsideRoster).toHaveBeenCalledWith([requestedPresenter]);
  });
});
