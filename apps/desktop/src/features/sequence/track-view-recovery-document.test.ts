import { describe, expect, it } from 'vitest';
import { validateTrackViewDocument } from '../../shared/track-view';
import { trackViewFixture } from '../../shared/track-view-fixture';
import { referenceSignature } from './bbi-reference-compatibility';
import { portableFingerprintFromIdentity } from './portable-genome-view-adapter';
import { planPortableTrackRestore } from './portable-genome-view-restore';
import { managedRestoredTracks, trackViewRecoveryDocument } from './track-view-recovery-document';
import { laneFromIndexedGenomeDataTrack } from './ucsc-track-persistence';
import { createIndexedBbiTrackId } from '@waypoint/genome-data';

describe('managed view recovery projection', () => {
  it('preflights the reference while keeping SSH sources as managed locators', async () => {
    const document = await managedSshViewFixture();
    const before = structuredClone(document);
    const recovery = await trackViewRecoveryDocument(document);
    expect(recovery.reference).toEqual(document.portableReference);
    expect(recovery.tracks).toEqual([]);
    expect(document).toEqual(before);
  });

  it('retains SSH reads and signal when the portable recovery plan admits no ordinary tracks', async () => {
    const document = await managedSshViewFixture();
    const recovered = managedRestoredTracks(document, {
      dataTracks: [],
      bamTracks: [],
      outcomes: [],
    });
    expect(recovered.bamTracks).toEqual(document.bamTracks);
    expect(recovered.dataTracks).toEqual(document.dataTracks);
    expect(recovered.signalReadPileupViews).toEqual(document.signalReadPileupViews);
    expect(recovered.primerBindings).toEqual(document.primerBindings);
    expect(recovered.userAnnotations).toEqual(document.userAnnotations);
  });

  it('round-trips local aligned reads and their display settings without a portable admission', async () => {
    const base = await managedSshViewFixture();
    const file = { size: 4096, mtimeNs: '17', ctimeNs: '21' };
    const source = {
      bamPath: '/data/sample.bam',
      indexPath: '/data/sample.bam.bai',
      generation: {
        contract: 'aligned-read-source-generation.v1',
        alignment: { ...file, canonicalPath: '/data/sample.bam' },
        index: { ...file, canonicalPath: '/data/sample.bam.bai' },
      },
    };
    const document = validateTrackViewDocument({
      ...base,
      bamTracks: [{ ...base.bamTracks[0], coverageCutoffDepth: 27, source }],
    });
    const plan = await trackViewRecoveryDocument(document);
    expect(plan.reference).toEqual(document.portableReference);
    expect(plan.tracks).toEqual([]);
    const restored = managedRestoredTracks(document, {
      dataTracks: [],
      bamTracks: [],
      outcomes: [],
    });
    expect(restored.bamTracks).toEqual(document.bamTracks);
    expect(restored.signalReadPileupViews).toEqual(document.signalReadPileupViews);
  });

  it('rejects a mismatched SSH signal receipt before projecting the recovery plan', async () => {
    const document = await managedSshViewFixture();
    const invalid = {
      ...document,
      dataTracks: document.dataTracks.map((track) => ({
        ...track,
        source: { ...track.source, uri: 'ssh://other-server/changed.bigWig' },
      })),
    };
    await expect(trackViewRecoveryDocument(invalid)).rejects.toThrow(
      'invalid durable SSH signal source'
    );
  });

  it('rebinds a durable SSH signal recipe to the recovered reference without a live admission', async () => {
    const document = await managedSshViewFixture();
    const assemblyId = 'local-abcdefabcdefabcdefabcdef';
    const recovered = managedRestoredTracks(
      document,
      { dataTracks: [], bamTracks: [], outcomes: [] },
      { assemblyId }
    );
    const signal = recovered.dataTracks[0]!;
    expect(signal.source.assemblyId).toBe(assemblyId);
    expect(signal.source.referenceReceipt.assemblyId).toBe(assemblyId);
    expect(signal.remoteSignal).toEqual(document.dataTracks[0]!.remoteSignal);
    const pending = laneFromIndexedGenomeDataTrack(signal, assemblyId);
    expect(pending.source).toBeUndefined();
    expect(pending.dataset.remoteSignal?.locator).toEqual(signal.remoteSignal);
  });

  it('rebinds an implicit SSH sibling signal without losing its saved composition', async () => {
    const base = await managedSshViewFixture();
    const source = { kind: 'url' as const, url: 'ssh://analysis-hpc/runs/42/signal.bigWig' };
    const previousSignalId = createIndexedBbiTrackId({
      assemblyId: base.reference.assemblyId,
      source,
    });
    const document = validateTrackViewDocument({
      ...base,
      dataTracks: [],
      signalReadPileupViews: [
        { ...base.signalReadPileupViews![0], signalTrackId: previousSignalId },
      ],
    });
    const assemblyId = 'local-abcdefabcdefabcdefabcdef';
    const recovered = managedRestoredTracks(
      document,
      { dataTracks: [], bamTracks: [], outcomes: [] },
      { assemblyId }
    );
    expect(recovered.signalReadPileupViews).toEqual([
      {
        ...document.signalReadPileupViews![0],
        signalTrackId: createIndexedBbiTrackId({ assemblyId, source }),
      },
    ]);
  });

  it('does not substitute an implicit SSH signal for an explicitly omitted ordinary signal with the same ID', async () => {
    const base = await managedSshViewFixture();
    const signalTrackId = createIndexedBbiTrackId({
      assemblyId: base.reference.assemblyId,
      source: { kind: 'url', url: 'ssh://analysis-hpc/runs/42/signal.bigWig' },
    });
    const document = validateTrackViewDocument({
      ...base,
      signalReadPileupViews: [{ ...base.signalReadPileupViews![0], signalTrackId }],
      dataTracks: base.dataTracks.map(({ remoteSignal: _remote, ...track }) => ({
        ...track,
        trackId: signalTrackId,
        source: {
          ...track.source,
          uri: 'file:///old/signal.bw',
          input: { kind: 'path', path: '/old/signal.bw' },
          fingerprint: 'ordinary-signal',
        },
      })),
    });
    const recovered = managedRestoredTracks(document, {
      dataTracks: [],
      bamTracks: [],
      outcomes: [],
    });
    expect(recovered.bamTracks).toEqual(document.bamTracks);
    expect(recovered.signalReadPileupViews).toEqual([]);
    expect(recovered.primerBindings).toEqual(document.primerBindings);
    expect(recovered.userAnnotations).toEqual(document.userAnnotations);
  });

  it('retains saved reference, camera and annotation facts for the recovery opener', async () => {
    const document = validateTrackViewDocument({
      ...trackViewFixture(),
      reference: {
        assemblyId: 'hg38',
        name: 'GRCh38',
        chromosomes: [{ chrom: 'chr1', length: 1_000 }],
        sourceFingerprint: 'a'.repeat(24),
        inventoryFingerprint: 'b'.repeat(64),
        bundleFingerprint: 'c'.repeat(64),
        sequenceIdentity: 'd'.repeat(64),
        annotationIdentity: 'e'.repeat(64),
      },
      portableReference: {
        kind: 'hosted-reference',
        catalogId: 'hg38',
        assemblyId: 'hg38',
        sourceFingerprint: 'a'.repeat(24),
        inventoryFingerprint: 'b'.repeat(64),
        bundleFingerprint: 'c'.repeat(64),
        sequenceIdentity: 'd'.repeat(64),
        annotationIdentity: 'e'.repeat(64),
      },
      viewport: { start0: 100, end0: 800 },
    });

    const recovery = await trackViewRecoveryDocument(document);
    expect(recovery.id).toBe(document.id);
    expect(recovery.reference).toEqual(document.portableReference);
    expect(recovery.viewport).toEqual({ kind: 'assembly-range', start0: 100, end0: 800 });
    expect(recovery.annotation).toEqual(document.annotation);
    expect(recovery.tracks).toEqual([]);
  });

  it('refuses a legacy view without exact portable reference identity', async () => {
    const document = validateTrackViewDocument(trackViewFixture());
    await expect(trackViewRecoveryDocument(document)).rejects.toThrow(
      'no portable reference identity'
    );
  });

  it('preflights a saved local track request for relinking on another computer', async () => {
    const base = trackViewFixture();
    const assemblyId = base.reference.assemblyId;
    const referenceSignatureValue = await portableFingerprintFromIdentity(
      await referenceSignature([{ name: 'pUC19', length: 2686 }])
    );
    const document = validateTrackViewDocument({
      ...base,
      portableReference: {
        kind: 'workspace-reference',
        entityId: assemblyId,
        assemblyId,
        contentFingerprint: `sha256:${'a'.repeat(64)}`,
        referenceSignature: referenceSignatureValue,
      },
      dataTracks: [
        {
          trackId: 'regions',
          trackType: 'generic-interval',
          label: 'Regions',
          color: 0x3b82f6,
          trackPx: 120,
          laneHeightPx: 8,
          maxLanes: 32,
          visible: true,
          source: {
            uri: 'file:///data/regions.bed',
            input: { kind: 'path', path: '/data/regions.bed' },
            formatId: 'bed',
            admissionVersion: 2,
            request: {
              contract: 'dnaforge.track-admission-request.v1',
              assemblyId,
              source: { kind: 'local-file', path: '/data/regions.bed' },
              formatId: 'bed',
              scientificKind: 'interval',
              ingress: { kind: 'file-picker' },
            },
            admittedAt: '2026-09-21T19:00:00.000Z',
            fingerprint: 'regions-source',
            readerKind: 'interval-text',
            scientificKind: 'interval',
            assemblyId,
            referenceReceipt: {
              assemblyId,
              referenceSignature: 'reference-signature',
              sourceSignature: 'source-signature',
              contigMap: { pUC19: 'pUC19' },
              checkedContigs: 1,
              status: 'compatible',
              checkedAt: '2026-09-21T19:00:00.000Z',
            },
            provenance: {},
          },
        },
      ],
    });
    const recovery = await trackViewRecoveryDocument(document);
    const plan = await planPortableTrackRestore(recovery.tracks, {
      exists: async () => false,
      credentialConnected: async () => true,
    });
    expect(plan).toMatchObject([
      {
        status: 'relink-required',
        missing: [{ role: 'source', path: '/data/regions.bed' }],
      },
    ]);
  });

  it('keeps quantitative presentation while replacing a moved source receipt', () => {
    const base = trackViewFixture();
    const source = {
      uri: 'file:///old/signal.bw',
      formatId: 'bigwig',
      admissionVersion: 1,
      fingerprint: 'old-source',
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      assemblyId: base.reference.assemblyId,
      referenceReceipt: {
        assemblyId: base.reference.assemblyId,
        referenceSignature: 'reference-signature',
        sourceSignature: 'source-signature',
        contigMap: { pUC19: 'pUC19' },
        checkedContigs: 1,
        status: 'compatible',
        checkedAt: '2026-09-08T00:00:00.000Z',
      },
      provenance: {},
    };
    const document = validateTrackViewDocument({
      ...base,
      dataTracks: [
        {
          trackId: 'signal-1',
          trackType: 'quantitative',
          label: 'Signal',
          order: 0,
          color: 0xe11d48,
          trackPx: 128,
          laneHeightPx: 8,
          maxLanes: 32,
          visible: true,
          quantitativePresentation: {
            version: 1,
            graph: 'bar',
            showRange: true,
            smoothingSigmaBins: 1.2,
            scale: { mode: 'full-global', transform: 'log1p' },
          },
          source,
        },
      ],
    });
    const original = document.dataTracks[0]!;
    const replacement = { ...original, source: { ...original.source, fingerprint: 'new-source' } };
    const recovered = managedRestoredTracks(document, {
      dataTracks: [replacement],
      bamTracks: [],
      outcomes: [{ trackId: 'signal-1', label: 'Signal', status: 'relinked' }],
    });
    expect(recovered.dataTracks[0]?.quantitativePresentation).toEqual(
      original.quantitativePresentation
    );
    expect(recovered.dataTracks[0]?.source.fingerprint).toBe('new-source');
    expect(recovered.dataTracks[0]?.color).toBe(0xe11d48);
  });
});

async function managedSshViewFixture() {
  const base = validateTrackViewDocument(trackViewFixture());
  const assemblyId = base.reference.assemblyId;
  const referenceSignatureValue = await portableFingerprintFromIdentity(
    await referenceSignature(
      base.reference.chromosomes.map(({ chrom, length }) => ({ name: chrom, length }))
    )
  );
  const target = 'analysis-hpc';
  const signalPath = '/runs/42/signal.bigWig';
  const uri = `ssh://${target}${signalPath}`;
  return validateTrackViewDocument({
    ...base,
    portableReference: {
      kind: 'workspace-reference',
      entityId: assemblyId,
      assemblyId,
      contentFingerprint: `sha256:${'a'.repeat(64)}`,
      referenceSignature: referenceSignatureValue,
    },
    signalReadPileupViews: [
      {
        contract: 'dnaforge.signal-read-pileup-view.v1',
        trackId: 'hybrid',
        readsTrackId: 'reads',
        signalTrackId: 'signal',
        label: 'Signal to reads',
        visible: true,
        color: 0xa8ceff,
        trackPx: 276,
        laneHeightPx: 3,
        maxLanes: 80,
        overflowBandHeightPx: 36,
        coverageCutoffDepth: 80,
        loadingAnimation: 'diagonal-scan',
      },
    ],
    primerBindings: [
      {
        id: 'binding-1',
        primerId: 'primer-1',
        primerName: 'Primer',
        primerBases: 'ACGT',
        chrom: 'pUC19',
        start0: 100,
        end0: 104,
        strand: '+',
        source: 'created',
      },
    ],
    userAnnotations: [
      {
        id: 'annotation-1',
        chrom: 'pUC19',
        annotation: { name: 'Site', type: 'misc_feature', start: 5, end: 40, direction: 1 },
      },
    ],
    bamTracks: [
      {
        trackId: 'reads',
        label: 'Reads',
        visible: true,
        coverageCutoffDepth: 80,
        source: {
          bamPath: '/runs/42/sample.bam',
          indexPath: '/runs/42/sample.bam.bai',
          remote: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'endpoint-42',
            target,
            alignmentPath: '/runs/42/sample.bam',
            indexPath: '/runs/42/sample.bam.bai',
            signalPath,
          },
        },
      },
    ],
    dataTracks: [
      {
        trackId: 'signal',
        trackType: 'quantitative',
        label: 'Signal',
        color: 0x3b82f6,
        trackPx: 120,
        laneHeightPx: 8,
        maxLanes: 32,
        visible: true,
        remoteSignal: {
          contract: 'remote-signal-locator.v1',
          endpointId: 'endpoint-42',
          target,
          signalPath,
        },
        source: {
          uri,
          input: { kind: 'url', url: uri },
          formatId: 'bigwig',
          admissionVersion: 1,
          fingerprint: ['remote-signal', uri].join('\0'),
          readerKind: 'bbi',
          recommendedTypes: ['quantitative'],
          scientificKind: 'quantitative',
          assemblyId,
          referenceReceipt: {
            assemblyId,
            referenceSignature: 'reference-signature',
            sourceSignature: 'source-signature',
            contigMap: { pUC19: 'pUC19' },
            checkedContigs: 1,
            status: 'compatible',
            checkedAt: '2026-09-21T19:00:00.000Z',
          },
          provenance: { provider: 'direct-url', sourceKind: 'remote-url', label: 'Signal' },
        },
      },
    ],
  });
}
