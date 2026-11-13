import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PartitionedInstancedTranscriptLayer } from '../overview/partitioned-instanced-transcript-layer';
import type { PrepackedAnnotationSceneStatus } from '../overview/prepacked-annotation-scene';
import {
  activatePrepackedAnnotationScene,
  applyAnnotationPresentationPolicy,
  disposePrepackedAnnotationScene,
  disposePrepackedAnnotationSceneLayer,
  evictPrepackedAnnotationSceneResidentsToLimit,
  type PrepackedPolicyHost,
  type PrepackedPolicyResident,
} from './indexed-prepacked-policy';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function layer(
  overrides: Partial<PartitionedInstancedTranscriptLayer> = {}
): PartitionedInstancedTranscriptLayer {
  return {
    isGpuPrepared: true,
    isPresenting: false,
    hide: () => undefined,
    show: () => undefined,
    destroy: () => undefined,
    container: {},
    getAnnotationPolicyDebug: () => ({ runtime: { isoformMode: 'canonical', laneLimit: 4 } }),
    beginAnnotationPolicyTransaction: () => ({
      submission: { directBankEnabled: false },
    }),
    canCommitAnnotationPolicyTransaction: () => true,
    commitAnnotationPolicyTransaction: () => undefined,
    rollbackAnnotationPolicyTransaction: () => undefined,
    updateVisibleRange: () => [{ instanceCount: 2 }],
    updateCamera: () => undefined,
    ...overrides,
  } as unknown as PartitionedInstancedTranscriptLayer;
}

function resident(
  partial: Partial<PrepackedPolicyResident> & { ownerKey: string }
): PrepackedPolicyResident {
  return {
    lastUsed: 1,
    policyGeneration: 1,
    viewportDetailPresentationAdmitted: true,
    visiblePartitionCount: 0,
    visibleInstanceCount: 0,
    metadata: { trackType: 'mRNA', themeMode: 'light' },
    input: {
      policyProjection: {} as unknown as PrepackedPolicyResident['input']['policyProjection'],
      policyGpuInstanceData: new Float32Array(0),
    },
    policyTrackLaneMaxima: { expanded: 3, canonical: 3 },
    layer: layer(),
    ...partial,
  };
}

function host(
  overrides: Partial<PrepackedPolicyHost> & {
    bank?: PrepackedPolicyResident[];
    replacements?: PrepackedPolicyResident[];
  } = {}
): PrepackedPolicyHost & {
  status: PrepackedAnnotationSceneStatus | null;
  destroyed: string[];
  retired: number;
  destroyedLayers: number;
  reconciled: boolean;
  clock: number;
  ownerGeneration: number;
  residentGeneration: number;
  transaction: boolean;
} {
  const {
    bank: bankOverride,
    replacements: replacementOverride,
    activeOwnerKey: activeOwnerKeyOverride,
    activeLayer: activeLayerOverride,
    activeInput: activeInputOverride,
    ...hostOverrides
  } = overrides;
  const bank = bankOverride ?? [];
  const replacements = replacementOverride ?? [];
  const residents = new Map(bank.map((entry) => [entry.ownerKey, entry]));
  const candidates = new Map(replacements.map((entry) => [entry.ownerKey, entry]));
  const frame: PrepackedPolicyHost & {
    status: PrepackedAnnotationSceneStatus | null;
    destroyed: string[];
    retired: number;
    destroyedLayers: number;
    reconciled: boolean;
    clock: number;
    ownerGeneration: number;
    residentGeneration: number;
    runtimePolicyValue: PrepackedPolicyHost['runtimePolicy'];
    policyGenerationValue: number;
    transaction: boolean;
    activeLayerValue: PrepackedPolicyHost['activeLayer'];
    activeOwnerKeyValue: string | null;
    activeInputValue: PrepackedPolicyHost['activeInput'];
  } = {
    transaction: false,
    activeLayerValue:
      activeLayerOverride === undefined ? (bank[0]?.layer ?? null) : activeLayerOverride,
    activeInputValue: activeInputOverride ?? null,
    activeOwnerKeyValue:
      activeOwnerKeyOverride === undefined ? (bank[0]?.ownerKey ?? null) : activeOwnerKeyOverride,
    requestedLayerTypes: ['mRNA'],
    lastPresentationCamera: null,
    lastCameraRequest: null,
    requirement: null,
    layout: null,
    contract: null,
    runtimePolicyValue: { isoformMode: 'canonical', laneLimit: 4 },
    policyGenerationValue: 1,
    lastPresentation: null,
    annotationTrackBaseOffset: 0,
    bodyPresentationGeneration: {},
    residentOwnerLimit: 16,
    lastCompleteOwnerKeys: bank.map(({ ownerKey }) => ownerKey),
    get transactionInFlight() {
      return frame.transaction;
    },
    get activeLayer() {
      return frame.activeLayerValue;
    },
    get activeInput() {
      return frame.activeInputValue;
    },
    get activeOwnerKey() {
      return frame.activeOwnerKeyValue;
    },
    get runtimePolicy() {
      return frame.runtimePolicyValue;
    },
    get policyGeneration() {
      return frame.policyGenerationValue;
    },
    get residentsSize() {
      return residents.size;
    },
    get hasResidentBank() {
      return residents.size > 0;
    },
    hasCompiledBroadSurface: false,
    get residents() {
      return residents.values();
    },
    get replacementCandidates() {
      return candidates.values();
    },
    status: null,
    destroyed: [],
    retired: 0,
    destroyedLayers: 0,
    reconciled: false,
    clock: 1,
    ownerGeneration: 0,
    residentGeneration: 0,
    getResident(ownerKey) {
      return residents.get(ownerKey);
    },
    ownerRosterForTheme: () => [],
    provenanceIsCurrent: () => false,
    candidateRegistrationMatches: () => false,
    laneStart: () => 0,
    ownerForTrack: () => null,
    candidateOwnerForTrack: () => null,
    stackMaxLane: () => -1,
    incrementPlanDerivationCount: () => undefined,
    setTransactionInFlight(value) {
      frame.transaction = value;
    },
    reconcileLaneEnvelope() {
      frame.reconciled = true;
    },
    resetAllPresentersToHidden: () => undefined,
    clearImmediateState: () => undefined,
    finalizeCandidateOwner: () => undefined,
    hideCompiledPresenters: () => undefined,
    setLastCompleteOwnerKeys(ownerKeys) {
      (frame as { lastCompleteOwnerKeys: readonly string[] }).lastCompleteOwnerKeys = ownerKeys;
    },
    setStatus(status) {
      frame.status = status;
    },
    setVisibleCounts: () => undefined,
    publishLaneEnvelope: () => undefined,
    setRuntimePolicy(policy) {
      frame.runtimePolicyValue = policy;
    },
    setPolicyGeneration(generation) {
      frame.policyGenerationValue = generation;
    },
    clearIdentityCaches: () => undefined,
    clearViewportSelectionCache: () => undefined,
    noteBodyPresentationCommit: () => undefined,
    bumpResidentClock() {
      frame.clock += 1;
      return frame.clock;
    },
    publishActiveOwner(item) {
      frame.activeLayerValue = item.layer;
      frame.activeOwnerKeyValue = item.ownerKey;
    },
    markInteractionCouplingValidated: () => undefined,
    bumpOwnerGeneration() {
      frame.ownerGeneration += 1;
    },
    destroyResident(ownerKey) {
      frame.destroyed.push(ownerKey);
      residents.delete(ownerKey);
    },
    removeLayerFromScene: () => undefined,
    retireLayer() {
      frame.retired += 1;
    },
    destroyLayer() {
      frame.destroyedLayers += 1;
    },
    clearResidentBank() {
      residents.clear();
      candidates.clear();
    },
    bumpResidentGeneration() {
      frame.residentGeneration += 1;
    },
    clearActiveOwner() {
      frame.activeLayerValue = null;
      frame.activeInputValue = null;
      frame.activeOwnerKeyValue = null;
    },
    setLastPresentation: () => undefined,
    setCouplingValidated: () => undefined,
    ...hostOverrides,
  };
  return frame;
}

describe('prepacked policy presenter', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('const completePolicyResidentRoster =');
    expect(source).not.toContain('const discardBroadCommits =');
    expect(source).not.toContain('const abortPolicyTransactions =');
    expect(source).not.toContain('Activation publishes the desired authority');
    expect(source).not.toContain('The limit bounds disposable cache entries');
    expect(source).not.toContain(
      'Defensive support for a partially constructed/legacy active owner'
    );
    expect(source).not.toContain('function applyAnnotationPresentationPolicy');
    expect(source).not.toContain('function activatePrepackedAnnotationSceneResident');
    expect(source).not.toContain('function evictPrepackedAnnotationSceneResidentsToLimit');
    expect(source).not.toContain('function disposePrepackedAnnotationSceneLayer');
  });

  it('exports the policy lifecycle entry points for the overlay façade', () => {
    expect(typeof applyAnnotationPresentationPolicy).toBe('function');
    expect(typeof activatePrepackedAnnotationScene).toBe('function');
    expect(typeof evictPrepackedAnnotationSceneResidentsToLimit).toBe('function');
    expect(typeof disposePrepackedAnnotationScene).toBe('function');
  });

  it('rejects an invalid or in-flight policy before touching residents', () => {
    const frame = host();
    expect(
      applyAnnotationPresentationPolicy(frame, {
        isoformMode: 'canonical',
        laneLimit: -1,
      })
    ).toBe(false);
    frame.transaction = true;
    expect(
      applyAnnotationPresentationPolicy(frame, {
        isoformMode: 'canonical',
        laneLimit: 4,
      })
    ).toBe(false);
    expect(frame.reconciled).toBe(false);
  });

  it('treats an already-published matching policy as an idempotent reconcile', () => {
    const existing = resident({ ownerKey: 'mrna' });
    const frame = host({ bank: [existing] });
    expect(
      applyAnnotationPresentationPolicy(frame, {
        isoformMode: 'canonical',
        laneLimit: 4,
      })
    ).toBe(true);
    expect(frame.reconciled).toBe(true);
    expect(frame.transaction).toBe(false);
  });

  it('waits for the All-track authority roster before acknowledging an already displayed policy', () => {
    const existing = resident({ ownerKey: 'mrna' });
    const trackTypes = ['mRNA', '3UTR', '5UTR', 'region'];
    const frame = host({
      bank: [existing],
      requestedLayerTypes: trackTypes,
      ownerRosterForTheme: (requested) =>
        requested.map((trackId) => ({
          trackId,
          owner: null,
          currentOwner: null,
          candidateOwner: null,
        })),
    });

    expect(
      applyAnnotationPresentationPolicy(frame, { isoformMode: 'canonical', laneLimit: 4 })
    ).toBe('deferred');
    expect(frame.runtimePolicy).toEqual({ isoformMode: 'canonical', laneLimit: 4 });
    expect(existing.policyGeneration).toBe(1);
    expect(frame.transaction).toBe(false);
    expect(frame.reconciled).toBe(false);
    expect(frame.destroyed).toEqual([]);
  });

  it.each(['generation', 'policy'] as const)(
    'rejects a complete roster with a stale resident %s instead of treating it as loading',
    (mismatch) => {
      const existing = resident({
        ownerKey: 'mrna',
        ...(mismatch === 'generation'
          ? { policyGeneration: 0 }
          : {
              layer: layer({
                getAnnotationPolicyDebug: () => ({
                  ...layer().getAnnotationPolicyDebug(),
                  runtime: { isoformMode: 'canonical', laneLimit: 8 },
                }),
              }),
            }),
      });
      const frame = host({ bank: [existing] });
      expect(
        applyAnnotationPresentationPolicy(frame, { isoformMode: 'canonical', laneLimit: 4 })
      ).toBe(false);
      expect(frame.runtimePolicy).toEqual({ isoformMode: 'canonical', laneLimit: 4 });
      expect(frame.reconciled).toBe(false);
      expect(frame.transaction).toBe(false);
    }
  );

  it('activates a GPU-ready current-generation resident without painting', () => {
    const existing = resident({ ownerKey: 'prepared' });
    const frame = host({
      bank: [existing],
      activeOwnerKey: null,
      activeLayer: null,
    });
    expect(activatePrepackedAnnotationScene(frame, 'prepared')).toBe(true);
    expect(frame.activeOwnerKey).toBe('prepared');
    expect(frame.status).toBe('eligible');
    expect(frame.ownerGeneration).toBe(1);
    expect(existing.lastUsed).toBe(2);
  });

  it('refuses a stale or unprepared activate', () => {
    const stale = resident({ ownerKey: 'stale', policyGeneration: 0 });
    const unprepared = resident({
      ownerKey: 'raw',
      layer: layer({ isGpuPrepared: false }),
    });
    const frame = host({ bank: [stale, unprepared], activeOwnerKey: null, activeLayer: null });
    expect(activatePrepackedAnnotationScene(frame, 'missing')).toBe(false);
    expect(activatePrepackedAnnotationScene(frame, 'stale')).toBe(false);
    expect(activatePrepackedAnnotationScene(frame, 'raw')).toBe(false);
    expect(frame.ownerGeneration).toBe(0);
  });

  it('evicts only disposable cache residents past the owner limit', () => {
    const keep = resident({ ownerKey: 'keep', lastUsed: 9 });
    const drop = resident({ ownerKey: 'drop', lastUsed: 1 });
    const frame = host({
      bank: [keep, drop],
      residentOwnerLimit: 1,
      activeOwnerKey: 'keep',
      lastCompleteOwnerKeys: ['keep'],
    });
    evictPrepackedAnnotationSceneResidentsToLimit(frame);
    expect(frame.destroyed).toEqual(['drop']);
    expect(frame.residentsSize).toBe(1);
  });

  it('retires a still-named layer and destroys a hidden leftover', () => {
    const presenting = layer({ isPresenting: true });
    const hidden = layer({ isPresenting: false });
    const frame = host();
    disposePrepackedAnnotationSceneLayer(frame, presenting, false);
    disposePrepackedAnnotationSceneLayer(frame, hidden, false);
    expect(frame.retired).toBe(1);
    expect(frame.destroyedLayers).toBe(1);
  });

  it('disposes the whole bank and clears the active owner', () => {
    const existing = resident({ ownerKey: 'mrna' });
    const frame = host({ bank: [existing] });
    disposePrepackedAnnotationScene(frame, 'not-loaded');
    expect(frame.hasResidentBank).toBe(false);
    expect(frame.activeOwnerKey).toBeNull();
    expect(frame.status).toBe('not-loaded');
    expect(frame.runtimePolicy).toBeNull();
    expect(frame.residentGeneration).toBe(1);
    expect(frame.ownerGeneration).toBe(1);
    expect(frame.reconciled).toBe(true);
  });
});
