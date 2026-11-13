import { describe, expect, it } from 'vitest';

import {
  AnnotationTrackOwnerCoordinatorV1,
  createAnnotationTrackLayoutSnapshotV1,
  createPreparedAnnotationTrackOwnerReceiptV1,
  createResidentAnnotationTrackOwnerV1,
  type AnnotationTrackOwnerRequestV1,
} from './annotation-track-owner-coordinator';

const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);

function ownerFor(request: AnnotationTrackOwnerRequestV1, overrides: Record<string, unknown> = {}) {
  return createResidentAnnotationTrackOwnerV1({
    trackId: request.trackId,
    artifactKey: request.artifactKey,
    artifactFingerprint: request.artifactFingerprint,
    policy: request.policy,
    broadOwnerId: `${request.trackId}:broad`,
    detailOwnerId: `${request.trackId}:detail`,
    interactionOwnerId: `${request.trackId}:interaction`,
    ordinaryPresentationOwners: [
      { ownerId: `${request.trackId}:broad`, ownerKind: 'broad' as const },
    ],
    ...overrides,
  });
}

function preparedFor(
  request: AnnotationTrackOwnerRequestV1,
  overrides: Record<string, unknown> = {}
) {
  return createPreparedAnnotationTrackOwnerReceiptV1({
    trackId: request.trackId,
    generation: request.generation,
    requestFingerprint: request.requestFingerprint,
    artifactKey: request.artifactKey,
    artifactFingerprint: request.artifactFingerprint,
    policy: request.policy,
    owner: ownerFor(request),
    ...overrides,
  });
}

function request(
  coordinator: AnnotationTrackOwnerCoordinatorV1,
  trackId = 'mrna',
  artifactFingerprint = FINGERPRINT_A
) {
  return coordinator.request({
    trackId,
    artifactKey: `bounded-annotation-artifact.v1:${trackId}`,
    artifactFingerprint,
    policy: { visible: true, isoformMode: 'expanded', laneLimit: 8 },
  });
}

function commit(
  coordinator: AnnotationTrackOwnerCoordinatorV1,
  requests: readonly AnnotationTrackOwnerRequestV1[],
  orderedVisibleTrackIds = requests
    .filter((entry) => entry.policy.visible)
    .map((entry) => entry.trackId)
) {
  return coordinator.commitPreparedSet({
    requests,
    layout: createAnnotationTrackLayoutSnapshotV1({
      layoutFingerprint: `layout:${orderedVisibleTrackIds.join(',') || 'empty'}`,
      orderedVisibleTrackIds,
    }),
  });
}

describe('annotation track owner coordinator', () => {
  it('moves requested -> preparing -> prepared -> committed and preserves immutable receipts', () => {
    const coordinator = new AnnotationTrackOwnerCoordinatorV1();
    const current = request(coordinator);
    expect(coordinator.stateFor('mrna').kind).toBe('requested');
    expect(coordinator.beginPreparation(current)).toEqual({ status: 'accepted' });
    expect(coordinator.stateFor('mrna').kind).toBe('preparing');

    const prepared = preparedFor(current);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(coordinator.acceptPrepared(prepared)).toEqual({ status: 'accepted' });
    expect(coordinator.stateFor('mrna').kind).toBe('prepared');
    expect(commit(coordinator, [current])).toEqual({
      status: 'committed',
      trackIds: ['mrna'],
      commitEpoch: 1,
    });
    expect(coordinator.stateFor('mrna').kind).toBe('committed');
    expect(coordinator.presentingOwnerFor('mrna')).toEqual(prepared.owner);
  });

  it('rejects a stale prepared receipt without replacing the last good owner', () => {
    const coordinator = new AnnotationTrackOwnerCoordinatorV1();
    const first = request(coordinator);
    coordinator.beginPreparation(first);
    coordinator.acceptPrepared(preparedFor(first));
    commit(coordinator, [first]);
    const lastGood = coordinator.presentingOwnerFor('mrna');

    const stale = request(coordinator, 'mrna', FINGERPRINT_A);
    coordinator.beginPreparation(stale);
    const current = request(coordinator, 'mrna', FINGERPRINT_B);
    expect(coordinator.acceptPrepared(preparedFor(stale))).toEqual({
      status: 'rejected',
      reason: 'stale-generation',
      trackId: 'mrna',
    });
    expect(coordinator.stateFor('mrna')).toMatchObject({
      kind: 'requested',
      request: { generation: current.generation },
    });
    expect(coordinator.presentingOwnerFor('mrna')).toEqual(lastGood);
  });

  it('rejects mismatched request and artifact fingerprints', () => {
    const coordinator = new AnnotationTrackOwnerCoordinatorV1();
    const current = request(coordinator);
    coordinator.beginPreparation(current);
    const mismatch = {
      ...preparedFor(current),
      requestFingerprint: 'wrong-request-fingerprint',
      artifactFingerprint: FINGERPRINT_B,
    };
    expect(coordinator.acceptPrepared(mismatch)).toEqual({
      status: 'rejected',
      reason: 'request-fingerprint-mismatch',
      trackId: 'mrna',
    });
    expect(coordinator.stateFor('mrna').kind).toBe('preparing');
  });

  it('rejects an artifact mismatch even when the request fingerprint matches', () => {
    const coordinator = new AnnotationTrackOwnerCoordinatorV1();
    const current = request(coordinator);
    coordinator.beginPreparation(current);
    const valid = preparedFor(current);
    const mismatch = {
      ...valid,
      artifactFingerprint: FINGERPRINT_B,
      owner: { ...valid.owner, artifactFingerprint: FINGERPRINT_B },
    };
    expect(coordinator.acceptPrepared(mismatch)).toEqual({
      status: 'rejected',
      reason: 'artifact-fingerprint-mismatch',
      trackId: 'mrna',
    });
    expect(coordinator.stateFor('mrna').kind).toBe('preparing');
  });

  it('snapshots an accepted raw receipt so later mutation cannot change the owner', () => {
    const coordinator = new AnnotationTrackOwnerCoordinatorV1();
    const current = request(coordinator);
    coordinator.beginPreparation(current);
    const immutable = preparedFor(current);
    const raw = {
      ...immutable,
      policy: { ...immutable.policy },
      owner: {
        ...immutable.owner,
        policy: { ...immutable.owner.policy },
        ordinaryPresentationOwners: immutable.owner.ordinaryPresentationOwners.map((entry) => ({
          ...entry,
        })),
      },
    };
    expect(coordinator.acceptPrepared(raw)).toEqual({ status: 'accepted' });
    raw.owner.broadOwnerId = 'mutated-after-accept';
    raw.owner.ordinaryPresentationOwners[0].ownerId = 'mutated-after-accept';
    expect(commit(coordinator, [current]).status).toBe('committed');
    expect(coordinator.presentingOwnerFor('mrna')).toMatchObject({
      broadOwnerId: 'mrna:broad',
      ordinaryPresentationOwners: [{ ownerId: 'mrna:broad', ownerKind: 'broad' }],
    });
    expect(Object.isFrozen(coordinator.presentingOwnerFor('mrna'))).toBe(true);
  });

  it('rejects a structurally invalid raw owner receipt fail-closed', () => {
    const coordinator = new AnnotationTrackOwnerCoordinatorV1();
    const current = request(coordinator);
    coordinator.beginPreparation(current);
    const valid = preparedFor(current);
    expect(
      coordinator.acceptPrepared({
        ...valid,
        owner: { ...valid.owner, interactionOwnerId: '' },
      })
    ).toEqual({
      status: 'rejected',
      reason: 'owner-receipt-invalid',
      trackId: 'mrna',
    });
    expect(coordinator.stateFor('mrna').kind).toBe('preparing');
  });

  it('rejects a second ordinary presentation owner', () => {
    const coordinator = new AnnotationTrackOwnerCoordinatorV1();
    const current = request(coordinator);
    coordinator.beginPreparation(current);
    const valid = preparedFor(current);
    const doubleOwner = {
      ...valid,
      owner: {
        ...valid.owner,
        ordinaryPresentationOwners: [
          { ownerId: 'mrna:broad', ownerKind: 'broad' },
          { ownerId: 'mrna:detail', ownerKind: 'detail' },
        ],
      },
    };
    expect(coordinator.acceptPrepared(doubleOwner)).toEqual({
      status: 'rejected',
      reason: 'ordinary-owner-cardinality-invalid',
      trackId: 'mrna',
    });
    expect(coordinator.presentingOwnerFor('mrna')).toBeNull();
  });

  it('commits a prepared track set atomically or leaves every track prepared', () => {
    const coordinator = new AnnotationTrackOwnerCoordinatorV1();
    const mrna = request(coordinator, 'mrna');
    const lncrna = request(coordinator, 'lncrna');
    coordinator.beginPreparation(mrna);
    coordinator.beginPreparation(lncrna);
    coordinator.acceptPrepared(preparedFor(mrna));
    coordinator.acceptPrepared(preparedFor(lncrna));

    const wrongLncrna = { ...lncrna, requestFingerprint: 'wrong' };
    expect(commit(coordinator, [mrna, wrongLncrna])).toEqual({
      status: 'rejected',
      reason: 'prepared-request-mismatch',
      trackId: 'lncrna',
    });
    expect(coordinator.stateFor('mrna').kind).toBe('prepared');
    expect(coordinator.stateFor('lncrna').kind).toBe('prepared');
    expect(coordinator.presentingOwnerFor('mrna')).toBeNull();
    expect(coordinator.presentingOwnerFor('lncrna')).toBeNull();
  });

  it.each(['failed', 'timeout'] as const)(
    'preserves the committed owner and presentation snapshot after preparation %s',
    (failureKind) => {
      const coordinator = new AnnotationTrackOwnerCoordinatorV1();
      const first = request(coordinator);
      coordinator.beginPreparation(first);
      coordinator.acceptPrepared(preparedFor(first));
      commit(coordinator, [first]);
      const lastGood = coordinator.presentingOwnerFor('mrna');
      const snapshot = coordinator.presentationSnapshot();

      const next = request(coordinator, 'mrna', FINGERPRINT_B);
      coordinator.beginPreparation(next);
      expect(
        coordinator.failPreparation(next, failureKind, `${failureKind}: compiler unavailable`)
      ).toEqual({ status: 'accepted' });
      expect(coordinator.stateFor('mrna')).toMatchObject({
        kind: 'failed',
        failureKind,
        lastGoodOwner: lastGood,
      });
      expect(coordinator.presentingOwnerFor('mrna')).toBe(lastGood);
      expect(coordinator.presentationSnapshot()).toBe(snapshot);
    }
  );

  it('retains a hidden owner resident but excludes it from ordinary presentation', () => {
    const coordinator = new AnnotationTrackOwnerCoordinatorV1();
    const hidden = coordinator.request({
      trackId: 'mrna',
      artifactKey: 'bounded-annotation-artifact.v1:mrna',
      artifactFingerprint: FINGERPRINT_A,
      policy: { visible: false, isoformMode: 'expanded', laneLimit: 8 },
    });
    coordinator.beginPreparation(hidden);
    coordinator.acceptPrepared(preparedFor(hidden));
    expect(commit(coordinator, [hidden], [])).toEqual({
      status: 'committed',
      trackIds: ['mrna'],
      commitEpoch: 1,
    });
    expect(coordinator.residentOwnerFor('mrna')).not.toBeNull();
    expect(coordinator.presentingOwnerFor('mrna')).toBeNull();
    expect(coordinator.presentationSnapshot()).toMatchObject({
      commitEpoch: 1,
      layout: { orderedVisibleTrackIds: [] },
      orderedVisibleOwners: [],
    });
  });

  it('atomically publishes an ordered visible owner/layout epoch and rejects an incomplete order', () => {
    const coordinator = new AnnotationTrackOwnerCoordinatorV1();
    const mrna = request(coordinator, 'mrna');
    const lncrna = request(coordinator, 'lncrna');
    coordinator.beginPreparation(mrna);
    coordinator.beginPreparation(lncrna);
    coordinator.acceptPrepared(preparedFor(mrna));
    coordinator.acceptPrepared(preparedFor(lncrna));

    expect(commit(coordinator, [mrna, lncrna], ['mrna'])).toEqual({
      status: 'rejected',
      reason: 'layout-visible-owner-set-mismatch',
    });
    expect(coordinator.presentationSnapshot()).toBeNull();
    expect(coordinator.stateFor('mrna').kind).toBe('prepared');
    expect(coordinator.stateFor('lncrna').kind).toBe('prepared');

    expect(commit(coordinator, [mrna, lncrna], ['lncrna', 'mrna'])).toEqual({
      status: 'committed',
      trackIds: ['mrna', 'lncrna'],
      commitEpoch: 1,
    });
    expect(coordinator.presentationSnapshot()).toMatchObject({
      commitEpoch: 1,
      layout: { orderedVisibleTrackIds: ['lncrna', 'mrna'] },
      orderedVisibleOwners: [{ trackId: 'lncrna' }, { trackId: 'mrna' }],
    });
    expect(Object.isFrozen(coordinator.presentationSnapshot())).toBe(true);
  });
});
