import { platform } from '../../platform';
import { createIndexedBbiTrackId, type PortableGenomeViewDocument } from '@waypoint/genome-data';
import { validateTrackViewDocument, type TrackViewDocument } from '../../shared/track-view';
import type { AdmitPortableTracksResult } from './portable-genome-view-restore';
import { portableFingerprintFromIdentity } from './portable-genome-view-adapter';
import { projectPortableGenomeView } from './portable-genome-view-adapter';
import { referenceSignature } from './bbi-reference-compatibility';

export async function trackViewRecoveryDocument(
  input: TrackViewDocument
): Promise<PortableGenomeViewDocument> {
  const document = validateTrackViewDocument(input);
  const reference = document.portableReference;
  if (!reference) {
    throw new Error(
      'This older Track view has no portable reference identity. Open it on the original computer and save it again before moving it.'
    );
  }
  if (reference.assemblyId !== document.reference.assemblyId) {
    throw new Error('The saved view has conflicting reference identities. Nothing was opened.');
  }
  if (reference.kind === 'workspace-reference') {
    const signature = await portableFingerprintFromIdentity(
      await referenceSignature(
        document.reference.chromosomes.map(({ chrom, length }) => ({ name: chrom, length }))
      )
    );
    if (reference.referenceSignature !== signature) {
      throw new Error('The saved view reference identity conflicts with its chromosome table.');
    }
  }

  if (document.sequenceDataLayers) {
    for (const source of document.sequenceDataLayers.layers) {
      const layer = await platform().sequenceDataLayers.run({
        operation: 'inspect',
        project: document.sequenceDataLayers.project,
        id: source.id,
      });
      if (
        layer.status !== 'published' ||
        layer.revision !== source.revision ||
        layer.document.target.documentId !== document.sequenceDataLayers.targetDocumentId ||
        layer.availability.status !== 'current'
      )
        throw new Error('A saved data layer version is unavailable. Nothing was saved or opened.');
    }
  }

  if (document.contactProjection) {
    await platform().contactSources.read({
      project: document.contactProjection.project,
      source: document.contactProjection.source,
    });
  }

  if (document.comparisonProjection) {
    await platform().comparisonSources.read({
      project: document.comparisonProjection.project,
      source: document.comparisonProjection.source,
    });
  }

  const projected = await projectPortableGenomeView({
    id: document.id,
    name: document.name,
    provenance: {
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      createdBy: { kind: 'user' },
    },
    reference,
    indexedGenome: {
      chrom: document.reference.chromosomes[0]?.chrom ?? '',
      assembly: { assemblyId: document.reference.assemblyId },
      scope: document.scope,
      dataTracks: document.dataTracks.filter((track) => !track.remoteSignal),
      bamTracks: document.bamTracks.filter((track) => !track.source.remote),
      variantSource: document.variantSource,
      ...(reference.kind === 'hosted-reference'
        ? {
            assemblyPortableBundleFingerprint: reference.bundleFingerprint,
            assemblyAssetGeneration: {
              sourceFingerprint: reference.sourceFingerprint,
              inventoryFingerprint: reference.inventoryFingerprint,
            },
            ...(reference.sequenceIdentity && reference.annotationIdentity
              ? {
                  assemblyReferenceIdentity: {
                    sequenceIdentity: reference.sequenceIdentity,
                    annotationIdentity: reference.annotationIdentity,
                  },
                }
              : {}),
          }
        : {}),
    },
    assemblyViewportRange: document.viewport,
    annotation: document.annotation,
  });
  if (projected.status === 'unsupported') {
    throw new Error(
      `This Track view cannot be recovered safely: ${projected.issues
        .map((issue) => issue.message)
        .join(' ')}`
    );
  }
  return projected.document;
}

export function managedRestoredTracks(
  input: TrackViewDocument,
  admitted: AdmitPortableTracksResult,
  referenceContext?: { readonly assemblyId: string }
): Pick<AdmitPortableTracksResult, 'dataTracks' | 'bamTracks' | 'variantSource'> &
  Pick<
    TrackViewDocument,
    | 'signalReadPileupViews'
    | 'primerBindings'
    | 'userAnnotations'
    | 'sequenceDataLayers'
    | 'contactProjection'
    | 'comparisonProjection'
  > {
  const document = validateTrackViewDocument(input);
  const dataById = new Map(admitted.dataTracks.map((track) => [track.trackId, track]));
  const bamById = new Map(admitted.bamTracks.map((track) => [track.trackId, track]));
  const restored: Pick<AdmitPortableTracksResult, 'dataTracks' | 'bamTracks' | 'variantSource'> = {
    dataTracks: document.dataTracks.flatMap((saved) => {
      if (saved.remoteSignal) {
        const assemblyId = referenceContext?.assemblyId ?? saved.source.assemblyId;
        return [
          {
            ...saved,
            source: {
              ...saved.source,
              assemblyId,
              referenceReceipt: { ...saved.source.referenceReceipt, assemblyId },
            },
          },
        ];
      }
      const restored = dataById.get(saved.trackId);
      return restored ? [{ ...saved, source: restored.source }] : [];
    }),
    bamTracks: document.bamTracks.flatMap((saved) => {
      if (saved.source.remote) return [saved];
      const restored = bamById.get(saved.trackId);
      return restored
        ? [
            {
              ...saved,
              source: restored.source,
              admittedSource: restored.admittedSource,
            },
          ]
        : [];
    }),
    ...(admitted.variantSource ? { variantSource: admitted.variantSource } : {}),
  };
  const reads = new Map(restored.bamTracks.map((track) => [track.trackId, track]));
  const explicitSignalIds = new Set(document.dataTracks.map((track) => track.trackId));
  const signals = new Set(
    restored.dataTracks
      .filter((track) => track.source.scientificKind === 'quantitative')
      .map((track) => track.trackId)
  );
  return {
    ...restored,
    signalReadPileupViews: document.signalReadPileupViews?.flatMap((view) => {
      const read = reads.get(view.readsTrackId);
      if (!read) return [];
      if (signals.has(view.signalTrackId)) return [view];
      if (explicitSignalIds.has(view.signalTrackId)) return [];
      const remote = read.source.remote;
      if (!remote?.signalPath) return [];
      const source = { kind: 'url' as const, url: `ssh://${remote.target}${remote.signalPath}` };
      const previousSignalId = createIndexedBbiTrackId({
        assemblyId: document.reference.assemblyId,
        source,
      });
      if (view.signalTrackId !== previousSignalId) return [];
      return [
        {
          ...view,
          signalTrackId: createIndexedBbiTrackId({
            assemblyId: referenceContext?.assemblyId ?? document.reference.assemblyId,
            source,
          }),
        },
      ];
    }),
    sequenceDataLayers: document.sequenceDataLayers,
    contactProjection: document.contactProjection,
    comparisonProjection: document.comparisonProjection,
    primerBindings: document.primerBindings,
    userAnnotations: document.userAnnotations,
  };
}
