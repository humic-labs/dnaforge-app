// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  compiledAnnotationBroadSetIsInteractive,
  compiledAnnotationDetailSetIsPrepared,
  qualifyCompiledAnnotationInteractionAuthority,
} from './compiled-annotation-interaction-authority';

function receipt() {
  return {
    contract: 'compiled-annotation-resident-readiness.v1',
    readinessScopeKey: 'scope-current',
    selectedTrackTypes: ['enhancer', 'mRNA'],
    selectedBroadSetInteractive: true,
    tracks: [
      {
        trackType: 'mRNA',
        interactionReadiness: 'loaded-hit',
        interactionOwnerKey: 'owner-mrna',
        compactInteractionStatus: 'loaded',
        compactInteractionOwnerKey: 'owner-mrna',
        ownerReadinessScopeKey: 'scope-current',
      },
      {
        trackType: 'enhancer',
        interactionReadiness: 'loaded-hit',
        interactionOwnerKey: 'owner-enhancer',
        compactInteractionStatus: 'loaded',
        compactInteractionOwnerKey: 'owner-enhancer',
        ownerReadinessScopeKey: 'scope-current',
      },
    ],
  } as const;
}

describe('qualifyCompiledAnnotationInteractionAuthority', () => {
  it('admits exact detail while unrelated broad-raster cells are still warming', () => {
    expect(
      compiledAnnotationDetailSetIsPrepared({
        readinessScopeKey: 'scope-current',
        selectedTrackTypes: ['enhancer', 'mRNA'],
        tracks: receipt().tracks.map((track) => ({
          ...track,
          readiness: 'loading',
          readinessRendererMatchesCurrent: true,
          targetIdentityKey: `target-${track.trackType}`,
          readinessTargetIdentityKey: `target-${track.trackType}`,
        })),
      })
    ).toBe(true);
  });

  it.each([
    ['one detail owner belongs to an older scope', { ownerReadinessScopeKey: 'scope-old' }],
    ['one detail owner belongs to another renderer', { readinessRendererMatchesCurrent: false }],
    ['one detail target is stale', { readinessTargetIdentityKey: 'target-old' }],
    ['one exact interaction is loading', { interactionReadiness: 'loading-hit' }],
    ['one exact interaction owner is absent', { interactionOwnerKey: null }],
  ])('rejects exact detail when %s', (_label, mutation) => {
    const current = receipt();
    const detailTracks = current.tracks.map((track) => ({
      ...track,
      readinessRendererMatchesCurrent: true,
      targetIdentityKey: `target-${track.trackType}`,
      readinessTargetIdentityKey: `target-${track.trackType}`,
    }));
    expect(
      compiledAnnotationDetailSetIsPrepared({
        readinessScopeKey: current.readinessScopeKey,
        selectedTrackTypes: current.selectedTrackTypes,
        tracks: [detailTracks[0], { ...detailTracks[1], ...mutation }],
      })
    ).toBe(false);
  });

  it('qualifies broad interaction independently for every exact raster-bound compact owner', () => {
    expect(
      compiledAnnotationBroadSetIsInteractive({
        ...receipt(),
        tracks: receipt().tracks.map((track) => ({
          ...track,
          interactionReadiness: 'loading-hit',
        })),
      })
    ).toBe(true);
  });

  it.each([
    ['one compact resident is loading', { compactInteractionStatus: 'loading' }],
    ['one compact owner is absent', { compactInteractionOwnerKey: null }],
    ['one compact owner names another raster', { compactInteractionOwnerKey: 'owner-forged' }],
    ['one receipt belongs to an older scope', { ownerReadinessScopeKey: 'scope-old' }],
  ])('rejects broad interaction when %s', (_label, mutation) => {
    const current = receipt();
    expect(
      compiledAnnotationBroadSetIsInteractive({
        ...current,
        tracks: [current.tracks[0], { ...current.tracks[1], ...mutation }],
      })
    ).toBe(false);
  });

  it('qualifies a general multi-type roster only when every selected interaction owner is resident', () => {
    const authority = qualifyCompiledAnnotationInteractionAuthority({
      receipt: receipt(),
      rendererCompactOwnerKeys: ['retained-old-owner', 'owner-mrna', 'owner-enhancer'],
      rendererCompactRosterGeneration: 9,
    });

    expect(authority).toMatchObject({
      contract: 'compiled-annotation-interaction-authority.v1',
      selectedTrackTypes: ['enhancer', 'mRNA'],
      expectedOwnerKeys: ['owner-enhancer', 'owner-mrna'],
      residentRosterGeneration: 9,
    });
  });

  it.each([
    ['missing physical owner', ['owner-mrna'], 9],
    ['invalid renderer generation', ['owner-mrna', 'owner-enhancer'], 0],
  ])('fails closed for %s', (_name, rendererCompactOwnerKeys, generation) => {
    expect(
      qualifyCompiledAnnotationInteractionAuthority({
        receipt: receipt(),
        rendererCompactOwnerKeys,
        rendererCompactRosterGeneration: generation,
      })
    ).toBeNull();
  });

  it('does not couple compact action authority to exact-detail loading', () => {
    const stale = receipt();
    expect(
      qualifyCompiledAnnotationInteractionAuthority({
        receipt: {
          ...stale,
          tracks: [stale.tracks[0], { ...stale.tracks[1], interactionReadiness: 'loading-hit' }],
        },
        rendererCompactOwnerKeys: ['owner-mrna', 'owner-enhancer'],
        rendererCompactRosterGeneration: 9,
      })
    ).not.toBeNull();
  });
});
