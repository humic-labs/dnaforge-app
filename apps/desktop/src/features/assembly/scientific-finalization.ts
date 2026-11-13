import type {
  ScientificAcceptedDocumentRevision,
  ScientificWorkspaceSubmitRequest,
  ScientificSubmittedFile,
} from '@waypoint/domain-services';
import {
  defineScientificAssemblyDraft,
  scientificIdentityPath,
  type ScientificSnapshot,
} from '@waypoint/scientific-objects';
import { defineBlob } from '@waypoint/workspace-revisions';
import { matchesSequenceChecksumIgnoringCase, parseGenBankFull } from '@waypoint/sequence-utils';
import { platform } from '../../platform';
import {
  fromPackageRelative,
  parseSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import { prepareSequencePackageRevision } from '../../db/sequence-package-versioning';
import { readScientificText } from '../scientific-document/public/read-scientific-text';
import { pathRelativeToBoundary } from '../../shared/path-boundary';
import { readScientificNamespace } from '../../services/read-scientific-namespace';
import { NativeArtifactPublicationPendingError } from '../../services/publish-native-artifact';
import { prepareUnboundPrimerArtifact } from '../primers/public/primer-artifact-service';
import {
  defaultPrimerArtifactPath,
  parsePrimerArtifact,
  serializePrimerArtifact,
} from '../primers/public/primer-artifact';
import { assemblyPrimerAnnealing, assemblyPrimerArtifactStem } from './primer-artifacts';
import {
  retireDesignArtifactMirror,
  resumeDesignArtifactMirror,
} from '../design/public/design-artifact-mirror';
import type { PreparedFinalizationCandidate } from './accepted-finalization-preview';
import { markAcceptedAssemblyVersionLifecycle } from './accepted-service';

export type PublishedScientificAssembly = {
  accepted: ScientificAcceptedDocumentRevision;

  ownedPaths: string[];
  primerCount: number;
};
type Capture = {
  request: ScientificWorkspaceSubmitRequest;
  ownedPaths: string[];
  primerCount: number;
};
const captures = new WeakMap<PreparedFinalizationCandidate, Capture>();

export async function publishScientificAssembly(
  candidate: PreparedFinalizationCandidate,
  workspaceRoot: string,
  mutationToken?: string
): Promise<PublishedScientificAssembly | null> {
  let capture = captures.get(candidate);
  if (!capture) {
    const namespace = await readScientificNamespace(workspaceRoot);
    if (!namespace) return null;
    const current = await platform().scientificObjects.list({
      workspaceRoot,
      request: { workspace: namespace.workspace },
    });
    if (current.head !== namespace.head)
      throw new Error('The accepted project changed before assembly capture. Preview it again.');
    const snapshots = new Map<string, ScientificSnapshot>();
    const entries = new Map<string, ScientificSubmittedFile>();
    for (const entry of current.entries) {
      const snapshot = await platform().scientificObjects.read({
        workspaceRoot,
        request: {
          workspace: namespace.workspace,
          resourceId: entry.resourceId,
          revisionId: entry.revisionId,
        },
      });
      if (!snapshot) throw new Error('An accepted assembly input is unavailable.');
      snapshots.set(entry.resourceId, snapshot);
      entries.set(entry.resourceId, {
        resourceId: entry.resourceId,
        path: entry.path,
        ...(snapshot.representation
          ? { representation: snapshot.representation }
          : { document: snapshot.document }),
      });
    }
    const version = markAcceptedAssemblyVersionLifecycle(
      candidate.prepared.acceptedVersion,
      'written'
    );
    const priorProduct = snapshots.get(candidate.constructId);
    let priorPackage = null;
    if (priorProduct) {
      if (
        priorProduct.document.kind !== 'sequence' ||
        priorProduct.representation?.format !== 'genbank-v1'
      )
        throw new Error('The previous assembly product is not an accepted native sequence.');
      const priorMetadata = await readScientificText(
        candidate.prepared.files.metaPath,
        workspaceRoot
      );
      if (priorMetadata.acceptedRevision?.workspaceVersionId !== namespace.head)
        throw new Error('The previous assembly package is not captured at the accepted head.');
      priorPackage = parseSequencePackageDocument(priorMetadata.content);
    }
    const versioned = await prepareSequencePackageRevision({
      current: priorPackage,
      currentProductContent: priorProduct?.representation?.text ?? null,
      next: parseSequencePackageDocument(candidate.prepared.files.sidecarJsonContent),
      nextProductContent: candidate.prepared.files.productGenBankContent,
      kind: 'assembly-finalization',
      operationId: `assembly-finalization:${version.id}`,
      revisionId: `assembly-finalization:${version.id}`,
      adoptedRevisionId: `adopted-before:${version.id}`,
      createdAt: version.acceptedAt,
    });
    candidate.prepared.files.sidecarJsonContent = serializeSequencePackageDocument(
      versioned.document
    );
    candidate.prepared.files.snapshotFiles = versioned.snapshots;
    const sources = new Map<
      string,
      { kind: 'accepted'; pin: { resourceId: string; revisionId: string } }
    >();
    for (const source of version.projectionInput.sourceProvenance) {
      const id = source.sourceConstructId ?? source.sourceSequenceId;
      const snapshot = snapshots.get(id);
      if (
        !snapshot ||
        snapshot.document.kind !== 'sequence' ||
        snapshot.representation?.format !== 'genbank-v1' ||
        !(await matchesSequenceChecksumIgnoringCase(
          parseGenBankFull(snapshot.representation.text).sequence,
          source.sourceSequenceChecksum
        ))
      )
        throw new Error(
          'An assembly source changed since this draft was prepared. Re-read its accepted sequence and preview again.'
        );
      sources.set(id, {
        kind: 'accepted',
        pin: { resourceId: id, revisionId: snapshot.revisionId },
      });
    }
    const ownedPaths = [
      candidate.prepared.files.productGenBankPath,
      candidate.prepared.files.metaPath,
      candidate.prepared.files.primerCsvPath,
      candidate.prepared.files.primerFastaPath,
      ...(candidate.prepared.files.snapshotFiles ?? []).map((snapshot) =>
        fromPackageRelative(snapshot.path, candidate.prepared.files.packageRoot)
      ),
    ];
    if (
      !candidate.overwrite &&
      ownedPaths.some((path) =>
        namespace.entries.some(
          (entry) => !entry.tombstone && entry.path === pathRelativeToBoundary(path, workspaceRoot)
        )
      )
    )
      throw new Error(
        'An accepted assembly product already occupies this destination. Preview an explicit replacement.'
      );
    entries.set(candidate.constructId, {
      resourceId: candidate.constructId,
      path: requireRelative(candidate.prepared.files.productGenBankPath, workspaceRoot),
      representation: {
        format: 'genbank-v1',
        text: candidate.prepared.files.productGenBankContent,
      },
    });

    const primers = new Map<
      string,
      | { kind: 'submitted'; resourceId: string }
      | { kind: 'accepted'; pin: { resourceId: string; revisionId: string } }
    >();
    const declaredOligos = new Map(
      (version.savedPrimerOligos ?? []).map((oligo) => [oligo.primerId, oligo])
    );
    for (const primer of version.projectionInput.designPrimers
      .flatMap((pair) => [pair.forward, pair.reverse])
      .filter((primer) => primer.sequence.trim())) {
      const declared = declaredOligos.get(primer.id);
      const declaredEntry = declared
        ? current.entries.find((entry) => entry.resourceId === declared.oligoId)
        : undefined;
      if (declared && declaredEntry) {
        const snapshot = snapshots.get(declaredEntry.resourceId);
        if (snapshot?.representation?.format !== 'primer-v2')
          throw new Error('The oligo this assembly primer declares is not an accepted primer.');
        const artifact = parsePrimerArtifact(snapshot.representation.text);
        if (artifact.sequence.bases.toUpperCase() !== primer.sequence.trim().toUpperCase())
          throw new Error(
            `Saved oligo ${artifact.name} no longer has the bases assembly primer ${primer.name} declares. Link it again and accept the assembly again.`
          );
        primers.set(declaredEntry.path, {
          kind: 'accepted',
          pin: { resourceId: snapshot.resourceId, revisionId: snapshot.revisionId },
        });
        continue;
      }
      const stem = await assemblyPrimerArtifactStem(primer);
      const path = defaultPrimerArtifactPath(workspaceRoot, stem),
        relative = requireRelative(path, workspaceRoot);
      const existing = current.entries.find((entry) => entry.path === relative);
      if (existing) {
        const snapshot = snapshots.get(existing.resourceId);
        if (snapshot?.representation?.format !== 'primer-v2')
          throw new Error('The assembly primer path belongs to another accepted kind.');
        const artifact = parsePrimerArtifact(snapshot.representation.text);
        if (
          artifact.name !== primer.name ||
          artifact.sequence.bases.toUpperCase() !== primer.sequence.trim().toUpperCase() ||
          artifact.metadata.source !== 'assembly' ||
          (artifact.annealing !== undefined &&
            (artifact.annealing.pbsSequence !== primer.pbs.sequence ||
              artifact.annealing.overhangSequence !==
                assemblyPrimerAnnealing(primer).overhangSequence))
        )
          throw new Error('A different accepted primer occupies this assembly primer path.');
        primers.set(relative, {
          kind: 'accepted',
          pin: { resourceId: snapshot.resourceId, revisionId: snapshot.revisionId },
        });
      } else if (!primers.has(relative)) {
        if (await platform().fs.exists(path))
          throw new Error(
            'An unenrolled working primer occupies this assembly primer path. Enroll it explicitly.'
          );
        const artifact = await prepareUnboundPrimerArtifact(
          {
            name: primer.name,
            sequence: primer.sequence,
            annealing: assemblyPrimerAnnealing(primer),
            artifactPath: path,
            workspaceRoot,
            origin: 'assembly',
            application: 'pcr',
            requireRegistry: true,
            actor: version.acceptedBy ?? 'local-user',
          },
          { mutationToken, now: Date.parse(version.acceptedAt) }
        );
        entries.set(artifact.id, {
          resourceId: artifact.id,
          path: relative,
          representation: { format: 'primer-v2', text: serializePrimerArtifact(artifact) },
        });
        primers.set(relative, { kind: 'submitted', resourceId: artifact.id });
      }
      if (!ownedPaths.includes(path)) ownedPaths.push(path);
    }
    const parentId = version.projectionInput.parentAcceptedAssemblyVersionId;
    const parent = parentId ? snapshots.get(`accepted-assembly:${parentId}`) : null;
    if (parentId && parent?.document.kind !== 'accepted-assembly')
      throw new Error('The parent assembly requires its exact accepted history.');
    const historyId = `accepted-assembly:${version.id}`;
    const historyPath = `.dnaforge/assemblies/${defineBlob(new TextEncoder().encode(historyId)).hash.slice('sha256:'.length)}.json`;
    const assembly = defineScientificAssemblyDraft({
      resourceId: historyId,
      path: historyPath,
      constructId: candidate.constructId,
      parent: parent ? { resourceId: parent.resourceId, revisionId: parent.revisionId } : null,
      sources: [...sources.values()],
      primers: [...primers.values()],
      product: { kind: 'submitted', resourceId: candidate.constructId },
      recipe: { nativeAcceptedVersion: JSON.parse(JSON.stringify(version)) },
    });
    const request = {
      workspace: namespace.workspace,
      expectedHead: namespace.head,
      source: {
        kind: 'accepted-assembly' as const,
        entries: [...entries.values()],
        assembly,
        nativePackage: {
          metadataText: candidate.prepared.files.sidecarJsonContent,
          primerCsvText: candidate.prepared.files.primerCsvContent,
          primerFastaText: candidate.prepared.files.primerFastaContent,
          snapshotFiles: candidate.prepared.files.snapshotFiles ?? [],
        },
      },
    };
    capture = {
      request: {
        ...request,
        operationId: `assembly-finalization:${defineBlob(new TextEncoder().encode(JSON.stringify(request))).hash.slice('sha256:'.length)}`,
      },
      ownedPaths: [
        ...ownedPaths,
        `${workspaceRoot}/${historyPath}`,
        `${workspaceRoot}/${scientificIdentityPath}`,
      ],
      primerCount: primers.size,
    };
    captures.set(candidate, capture);
  }
  await retireDesignArtifactMirror(candidate.design.id);
  let accepted: ScientificAcceptedDocumentRevision | undefined;
  try {
    const result = await platform().scientificObjects.submit({
      workspaceRoot,
      request: capture.request,
      ...(mutationToken ? { mutationToken } : {}),
    });
    if (result.receipt.outcome === 'conflict' || result.receipt.outcome === 'rejected')
      throw new Error(
        'The assembly acceptance conflicts with a newer project version. Preview it again.'
      );
    accepted = result.accepted;
    if (!accepted)
      throw new Error('Assembly acceptance did not return its exact product revision.');
    if (result.delivery?.kind !== 'complete')
      throw new NativeArtifactPublicationPendingError(
        accepted,
        `assembly file delivery remains pending: ${result.delivery?.kind === 'blocked' ? result.delivery.error : 'unavailable'}`
      );
    return { accepted, ownedPaths: capture.ownedPaths, primerCount: capture.primerCount };
  } catch (error) {
    if (!accepted) resumeDesignArtifactMirror(candidate.design.id);
    throw error;
  }
}

function requireRelative(path: string, root: string): string {
  const relative = pathRelativeToBoundary(path, root);
  if (!relative) throw new Error('The assembly publication path escapes its project.');
  return relative;
}
