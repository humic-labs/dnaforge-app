import {
  compileScientificWorkspace,
  createScientificReader,
  defineScientificDocument,
  defineScientificFile,
  type PrimerBindingDocument,
  type RevisionPin,
  type ScientificFileEntry,
  type ScientificGraphInput,
  type ScientificSnapshot,
  type StrainDescentDocument,
  type StrainSequenceDocument,
} from '@waypoint/scientific-objects';
import {
  defineBlob,
  listWorkspaceResources,
  parseResourceId,
  parseWorkspacePath,
  previewMutationRevision,
  type ResourceId,
  type ResourceRevisionId,
  type Result,
} from '@waypoint/workspace-revisions';
import { parsePrimerArtifact } from '../shared/primers/primer-artifact';
import { scientificNativeCodecs } from './scientific-native-codecs';
import {
  nativePlacementCoordinatesMatch,
  nativePlacementTargetMatches,
  nativeStrainRelationshipMatches,
  parseNativeStrainRelationships,
} from './scientific-native-references';

const must = <T, E>(result: Result<T, E>): T => {
  if (!result.ok)
    throw new TypeError(`Invalid native scientific identity: ${JSON.stringify(result.error)}`);
  return result.value;
};

export function expandScientificNativeEntries(
  input: ScientificGraphInput & {
    readonly entries: readonly ScientificFileEntry[];
    readonly restores?: ReadonlyMap<ResourceId, ResourceRevisionId>;
  }
): readonly ScientificFileEntry[] {
  const proposed = compileScientificWorkspace({ ...input, codecs: scientificNativeCodecs });
  const before = createScientificReader({ ...input, codecs: scientificNativeCodecs });
  const entries = new Map(input.entries.map((entry) => [entry.resourceId, entry]));
  const revisions = new Map<ResourceId, RevisionPin>();
  for (const mutation of proposed.mutations)
    if (
      mutation.kind === 'create-resource' ||
      mutation.kind === 'edit-resource' ||
      mutation.kind === 'edit-and-move-resource' ||
      mutation.kind === 'restore-resource' ||
      mutation.kind === 'restore-and-edit-resource'
    )
      revisions.set(mutation.resourceId, {
        resourceId: mutation.resourceId,
        revisionId: previewMutationRevision(input.graph, mutation),
      });
  const future = new Map<ResourceId, ScientificSnapshot>();
  for (const entry of input.entries) {
    const pin = revisions.get(entry.resourceId);
    if (!pin) throw new TypeError('Native submission has no tentative resource pin.');
    const defined = defineScientificFile(entry, scientificNativeCodecs);
    future.set(entry.resourceId, {
      ...pin,
      document: defined.document,
      scientificHash: defined.scientificHash,
      bindingInputHash: defined.bindingInputHash,
      ...(entry.representation ? { representation: entry.representation } : {}),
    });
  }
  const nativePrimers = new Set<ResourceId>();
  for (const snapshot of before.listCurrent())
    if (snapshot.representation?.format === 'primer-v2') nativePrimers.add(snapshot.resourceId);
  const claimed = new Map<ResourceId, ResourceId>();
  const slots = input.head === null ? [] : must(listWorkspaceResources(input.graph, input.head));
  const paths = new Map(slots.map((slot) => [slot.resourceId, slot.path]));
  for (const entry of input.entries) {
    if (entry.representation?.format !== 'primer-v2') continue;
    nativePrimers.add(entry.resourceId);
    const primer = parsePrimerArtifact(entry.representation.text);
    for (const binding of primer.bindings) {
      if (!binding.target.documentId)
        throw new TypeError(
          'Path-only legacy primer placements require explicit stable-identity migration.'
        );
      const resourceId = must(parseResourceId(binding.id));
      if (claimed.has(resourceId))
        throw new TypeError('Native placement identity is declared by more than one primer.');
      claimed.set(resourceId, entry.resourceId);
      const incoming = future.get(resourceId);
      const old = before.current(resourceId);
      if (incoming && incoming.document.kind !== 'primer-binding')
        throw new TypeError('Native placement identity belongs to another scientific kind.');
      if (old && old.document.kind !== 'primer-binding')
        throw new TypeError(
          'Native placement identity already belongs to another scientific kind.'
        );
      const explicit = incoming && incoming.scientificHash !== old?.scientificHash;
      let target: RevisionPin | null = null;
      if (explicit && incoming.document.kind === 'primer-binding') {
        const document = incoming.document;
        const submittedTarget = future.get(document.target.resourceId);
        const snapshot =
          submittedTarget?.revisionId === document.target.revisionId
            ? submittedTarget
            : before.revision(document.target);
        if (
          document.primerId !== entry.resourceId ||
          !nativePlacementCoordinatesMatch(binding, document) ||
          !nativePlacementTargetMatches(binding, snapshot)
        )
          throw new TypeError(
            'Competing native placement and explicit binding do not match the same pinned snapshot.'
          );
        target = document.target;
      } else if (
        old?.document.kind === 'primer-binding' &&
        old.document.primerId === entry.resourceId &&
        nativePlacementCoordinatesMatch(binding, old.document) &&
        nativePlacementTargetMatches(binding, before.revision(old.document.target))
      ) {
        target = old.document.target;
      } else {
        const targetId = must(parseResourceId(binding.target.documentId));
        const snapshot = future.get(targetId) ?? null;
        const current = before.current(targetId);
        if (nativePlacementTargetMatches(binding, snapshot))
          target = { resourceId: snapshot.resourceId, revisionId: snapshot.revisionId };
        else if (nativePlacementTargetMatches(binding, current))
          target = { resourceId: current.resourceId, revisionId: current.revisionId };
      }
      if (!target)
        throw new TypeError(
          `Native placement requires an exact matching accepted or submitted target snapshot: ${binding.id}`
        );
      const document: PrimerBindingDocument = {
        formatVersion: 1,
        kind: 'primer-binding',
        primerId: entry.resourceId,
        target,
        coordinates: {
          start: binding.coordinates.start,
          end: binding.coordinates.end,
          strand: binding.coordinates.strand,
        },
      };
      const path =
        entries.get(resourceId)?.path ??
        paths.get(resourceId) ??
        must(
          parseWorkspacePath(
            `.dnaforge/relationships/${defineBlob(new TextEncoder().encode(resourceId)).hash.slice('sha256:'.length)}.json`
          )
        );
      entries.set(
        resourceId,
        Object.freeze({ resourceId, path, document: defineScientificDocument(document).document })
      );
    }
  }
  const nativeStrains = new Set<ResourceId>();
  for (const snapshot of before.listCurrent())
    if (snapshot.representation?.format === 'strain-entity-v1')
      nativeStrains.add(snapshot.resourceId);
  const strainClaims = new Set<ResourceId>();
  for (const entry of input.entries) {
    if (entry.representation?.format !== 'strain-entity-v1') continue;
    nativeStrains.add(entry.resourceId);
    for (const claim of parseNativeStrainRelationships(entry.representation.text)) {
      if (strainClaims.has(claim.resourceId))
        throw new TypeError('Native strain relationship identity has more than one owner.');
      strainClaims.add(claim.resourceId);
      const incoming = future.get(claim.resourceId),
        old = before.current(claim.resourceId);
      const kind = claim.kind === 'strain-descent' ? 'strain' : 'sequence';
      let target: RevisionPin | null = null;
      const targetOf = (document: StrainSequenceDocument | StrainDescentDocument) =>
        document.kind === 'strain-descent' ? document.parent : document.sequence;
      if (incoming && incoming.scientificHash !== old?.scientificHash) {
        const document = incoming.document;
        if (
          (document.kind !== 'strain-descent' && document.kind !== 'strain-sequence') ||
          !nativeStrainRelationshipMatches(claim, document)
        )
          throw new TypeError(
            'Competing native strain link and explicit relationship do not match.'
          );
        target = targetOf(document);
      } else if (
        old &&
        (old.document.kind === 'strain-descent' || old.document.kind === 'strain-sequence')
      ) {
        const previous = targetOf(old.document);
        if (
          old.document.kind === claim.kind &&
          old.document.strainId === claim.strainId &&
          previous.resourceId === claim.targetId &&
          (claim.targetRevisionId === null || claim.targetRevisionId === previous.revisionId)
        )
          target = previous;
      } else if (old || incoming)
        throw new TypeError(
          'Native strain relationship identity belongs to another scientific kind.'
        );
      if (!target) {
        const submitted = future.get(claim.targetId) ?? null;
        const snapshot =
          claim.targetRevisionId === null
            ? (submitted ?? before.current(claim.targetId))
            : submitted?.revisionId === claim.targetRevisionId
              ? submitted
              : before.revision({ resourceId: claim.targetId, revisionId: claim.targetRevisionId });
        if (snapshot?.document.kind !== kind)
          throw new TypeError(
            'Native strain link requires an exact accepted or submitted target of the right kind.'
          );
        target = { resourceId: snapshot.resourceId, revisionId: snapshot.revisionId };
      }
      const submitted = future.get(target.resourceId);
      const selected =
        submitted?.revisionId === target.revisionId ? submitted : before.revision(target);
      if (selected?.document.kind !== kind)
        throw new TypeError(
          'Native strain link pinned target is unavailable or has the wrong kind.'
        );
      const document = {
        formatVersion: 1,
        kind: claim.kind,
        strainId: claim.strainId,
        ...(claim.kind === 'strain-descent' ? { parent: target } : { sequence: target }),
        assertion: 'planned',
        evidence: [],
        fields: claim.fields,
      };
      const path =
        entries.get(claim.resourceId)?.path ??
        paths.get(claim.resourceId) ??
        must(
          parseWorkspacePath(
            `.dnaforge/relationships/${defineBlob(new TextEncoder().encode(claim.resourceId)).hash.slice('sha256:'.length)}.json`
          )
        );
      entries.set(
        claim.resourceId,
        Object.freeze({
          resourceId: claim.resourceId,
          path,
          document: defineScientificDocument(document).document,
        })
      );
    }
  }
  for (const [resourceId, entry] of entries) {
    const document = defineScientificFile(entry, scientificNativeCodecs).document;
    if (
      (document.kind === 'strain-descent' || document.kind === 'strain-sequence') &&
      nativeStrains.has(document.strainId) &&
      !strainClaims.has(resourceId)
    ) {
      const old = before.current(resourceId);
      if (!old || old.scientificHash !== defineScientificDocument(document).scientificHash)
        throw new TypeError(
          'An explicit strain relationship edit requires its matching native record projection.'
        );
      entries.delete(resourceId);
      continue;
    }
    if (
      document.kind !== 'primer-binding' ||
      !nativePrimers.has(document.primerId) ||
      claimed.has(resourceId)
    )
      continue;
    const old = before.current(resourceId);
    if (!old || old.scientificHash !== defineScientificDocument(document).scientificHash)
      throw new TypeError(
        'An explicit binding edit requires its matching native primer projection.'
      );
    entries.delete(resourceId);
  }
  return Object.freeze([...entries.values()]);
}
