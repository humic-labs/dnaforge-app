import type { RegisteredSequencePackagePublicationContext } from './sequence-package-registry-publication';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  prepareSequenceQueryAttachments,
  readAttachedEvidenceQueryPaths,
} from './sequence-evidence-query-attachments';
import { decodeSequenceDocument, interpretReferenceAlignment } from '@waypoint/sequence-utils';
import {
  fromPackageRelative,
  parseSequencePackageDocument,
  sequencePackagePaths,
  type SequencePackageDocument,
  type SequencePackageEvidenceArtifact,
  type SequencePackageEvidenceRun,
  type SequencePackageMember,
} from '../db/sequence-package';
import { sequenceReferenceCheckpointId } from '../db/sequence-package-versioning';
import type {
  ActivateSequenceEvidenceRunRequest,
  AppendSequenceEvidenceStateRequest,
  CompleteSequenceEvidenceRunRequest,
  CompleteSequenceEvidenceRunResult,
  FailSequenceEvidenceRunRequest,
  PrepareSequenceEvidenceRunRequest,
  PrepareSequenceEvidenceRunResult,
  PublishSequenceAlignmentHistoryRequest,
} from '../shared/sequence-package-evidence';
import {
  PAIRWISE_EVIDENCE_PARAMETERS,
  MAX_SEQUENCE_EVIDENCE_INPUT_BYTES,
} from '../shared/sequence-package-evidence';
import { isBinarySequencePath } from '../shared/parse-sequence-file';
import {
  canonicalWorkspacePath,
  writeWorkspaceBinaryFileAtomicInMain,
} from './primer-artifact-files';
import { withPublishedSequenceEvidenceMutationInMain } from './sequence-package-revision-publication';
import {
  readAcceptedSequencePackageBytes,
  stageAcceptedSequencePackageFile,
} from './sequence-package-publication-owner';

interface EvidenceInvocationAuthority {
  assertCurrent(): void;
  recordNewImmutableWrite(): void;
}

function createEvidenceInvocationAuthority(
  assertCurrent?: () => void
): EvidenceInvocationAuthority {
  let published = false;
  return {
    assertCurrent() {
      if (!published) assertCurrent?.();
    },
    recordNewImmutableWrite() {
      published = true;
    },
  };
}

const MAX_EVIDENCE_BATCH_BYTES = 100 * 1024 * 1024;
const MAX_EVIDENCE_RESULT_BYTES = 25 * 1024 * 1024;

export async function prepareSequenceEvidenceRunInMain(
  input: PrepareSequenceEvidenceRunRequest,
  contextOrAssert?: RegisteredSequencePackagePublicationContext | (() => void),
  resolveQuerySource?: (path: string) => Promise<string>,
  assertCurrent?: () => void
): Promise<PrepareSequenceEvidenceRunResult> {
  const suppliedContext = typeof contextOrAssert === 'function' ? undefined : contextOrAssert;
  const authority = createEvidenceInvocationAuthority(
    typeof contextOrAssert === 'function' ? contextOrAssert : assertCurrent
  );
  assertRequest(input);
  if (
    !input.sessionId ||
    input.sessionId.length > 256 ||
    !input.session ||
    !input.session.name ||
    !input.session.createdAt ||
    (input.session.mode !== 'one-per-clone' && input.session.mode !== 'multi-per-clone') ||
    !Array.isArray(input.queries) ||
    input.queries.length === 0 ||
    input.queries.length > 64
  ) {
    throw new Error('Evidence run has an invalid session or query count.');
  }
  const queryIds = new Set<string>();
  for (const query of input.queries) {
    if (
      !query ||
      typeof query.id !== 'string' ||
      !query.id ||
      query.id.length > 256 ||
      typeof query.label !== 'string' ||
      !query.label ||
      query.label.length > 256 ||
      typeof query.path !== 'string' ||
      !query.path ||
      queryIds.has(query.id)
    ) {
      throw new Error('Evidence run has a missing or duplicate query identity.');
    }
    queryIds.add(query.id);
  }
  return withPublishedSequenceEvidenceMutationInMain(
    input.workspaceRoot,
    input.packageRoot,
    async (publishMarker) => {
      const { markerPath, content, document } = await readMarker(input);
      const prior = document.evidenceRuns?.find((run) => run.id === input.runId);
      if (prior) {
        if (
          prior.sessionId !== input.sessionId ||
          JSON.stringify(prior.session) !== JSON.stringify(input.session) ||
          prior.queries.length !== input.queries.length ||
          prior.queries.some(
            (query, index) =>
              query.id !== input.queries[index].id || query.label !== input.queries[index].label
          )
        ) {
          throw new Error('Evidence run ID is already bound to different inputs.');
        }
        await verifyRunArtifacts(input, prior);
        return preparedReceipt(
          input,
          prior,
          markerPath,
          await readAttachedEvidenceQueryPaths(input.packageRoot, document, prior, input.queries)
        );
      }
      const productPath = sequencePackagePaths(input.packageRoot, {
        productFile: document.product.file,
      }).productPath;
      const source = await canonicalWorkspacePath({
        workspaceRoot: input.packageRoot,
        path: input.sourcePath,
        artifactNoun: 'evidence reference',
      });
      const product = await canonicalWorkspacePath({
        workspaceRoot: input.packageRoot,
        path: productPath,
        artifactNoun: 'evidence reference',
      });
      if (source.candidate !== product.candidate) {
        throw new Error('Evidence reference must be this package’s product.');
      }
      const referenceBytes = await boundedRead(source.candidate);
      const referenceSha256 = sha256(referenceBytes);
      const referenceDocument = decodeSequenceDocument(
        new TextDecoder('utf-8', { fatal: true }).decode(referenceBytes),
        {
          path: source.candidate,
          filename: basename(source.candidate),
        }
      );
      const referenceSequence = referenceDocument.sequence.sequence;
      const referenceRevision = scientificRevision('pairwise-reference', referenceSequence);
      const topology = referenceDocument.sequence.circular ? 'circular' : 'linear';
      const head = document.versionHistory.revisions.find(
        (revision) => revision.id === document.versionHistory.headId
      );
      const checkpointId =
        head?.productSnapshot.sha256 === referenceSha256
          ? sequenceReferenceCheckpointId(document)
          : null;
      const referenceArtifact: SequencePackageEvidenceArtifact = {
        path: `contents/evidence/${input.runId}/reference${extname(document.product.file) || '.gb'}`,
        sha256: referenceSha256,
      };
      const queryArtifacts: Array<{
        id: string;
        label: string;
        artifact: SequencePackageEvidenceArtifact;
        bytes: Uint8Array;
        sourcePath: string;
      }> = [];
      let totalBytes = referenceBytes.byteLength;
      for (const [index, query] of input.queries.entries()) {
        const queryPath = resolveQuerySource
          ? await resolveQuerySource(query.path)
          : (
              await canonicalWorkspacePath({
                workspaceRoot: input.workspaceRoot,
                path: query.path,
                artifactNoun: 'evidence query',
              })
            ).candidate;
        const bytes = await boundedRead(queryPath);
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_EVIDENCE_BATCH_BYTES) {
          throw new Error('Evidence input batch exceeds its package limit.');
        }
        const extension = extname(queryPath).toLowerCase();
        if (!/^\.[a-z0-9]{1,12}$/.test(extension)) {
          throw new Error('Evidence query has an unsupported file extension.');
        }
        queryArtifacts.push({
          id: query.id,
          label: query.label,
          sourcePath: queryPath,
          artifact: {
            path: `contents/evidence/${input.runId}/query-${index}${extension}`,
            sha256: sha256(bytes),
          },
          bytes,
        });
      }
      if (sha256(await boundedRead(source.candidate)) !== referenceSha256) {
        throw new Error('Evidence reference changed while inputs were frozen.');
      }
      const attachments = await prepareSequenceQueryAttachments({
        ...input,
        markerContent: content,
        queries: queryArtifacts.map((query) => ({
          id: query.id,
          path: query.sourcePath,
          bytes: query.bytes,
        })),
      });
      await writeImmutableBytes(input, referenceArtifact, referenceBytes, authority);
      for (const query of queryArtifacts) {
        await writeImmutableBytes(input, query.artifact, query.bytes, authority);
      }
      for (const file of attachments.files) {
        const path = file.path.slice(input.packageRoot.length + 1).replace(/\\/g, '/');
        await writeImmutableBytes(
          input,
          { path, sha256: sha256(file.bytes) },
          file.bytes,
          authority
        );
      }
      const run: SequencePackageEvidenceRun = {
        id: input.runId,
        sessionId: input.sessionId,
        session: input.session,
        createdAt: new Date().toISOString(),
        status: 'prepared',
        reference: {
          artifact: referenceArtifact,
          sequenceRevision: referenceRevision,
          topology,
          checkpointId,
        },
        queries: queryArtifacts.map(({ id, label, artifact }) => ({ id, label, artifact })),
        producer: {
          kind: 'pairwise-session-alignment',
          ...PAIRWISE_EVIDENCE_PARAMETERS,
          isCircular: topology === 'circular',
        },
      };
      const members: SequencePackageMember[] = [
        ...attachments.document.members,
        evidenceMember(input.runId, 'reference', referenceArtifact, 'evidence-input'),
        ...queryArtifacts.map((query, index) =>
          evidenceMember(input.runId, `query-${index}`, query.artifact, 'evidence-input')
        ),
      ];
      await publishMarker(content, {
        ...document,
        members,
        evidenceRuns: [...(document.evidenceRuns ?? []), run],
        updatedAt: new Date().toISOString(),
      });
      return preparedReceipt(
        input,
        run,
        markerPath,
        await readAttachedEvidenceQueryPaths(
          input.packageRoot,
          { ...document, members },
          run,
          input.queries
        )
      );
    },
    suppliedContext,
    () => authority.assertCurrent()
  );
}

export async function activateSequenceEvidenceRunInMain(
  input: ActivateSequenceEvidenceRunRequest,
  contextOrAssert?: RegisteredSequencePackagePublicationContext | (() => void),
  assertCurrent?: () => void
): Promise<SequencePackageEvidenceRun> {
  const suppliedContext = typeof contextOrAssert === 'function' ? undefined : contextOrAssert;
  const authority = createEvidenceInvocationAuthority(
    typeof contextOrAssert === 'function' ? contextOrAssert : assertCurrent
  );
  assertRequest(input);
  if (!input.managedOperationId || !input.inputRevision) {
    throw new Error('Evidence operation identity is invalid.');
  }
  return withPublishedSequenceEvidenceMutationInMain(
    input.workspaceRoot,
    input.packageRoot,
    async (publishMarker) => {
      const { content, document } = await readMarker(input);
      const run = document.evidenceRuns?.find((candidate) => candidate.id === input.runId);
      if (!run) throw new Error('Prepared evidence run is missing.');
      if (run.managedOperationId || run.inputRevision) {
        if (
          run.managedOperationId !== input.managedOperationId ||
          run.inputRevision !== input.inputRevision
        ) {
          throw new Error('Evidence run is already bound to another managed operation.');
        }
        return run;
      }
      if (run.status !== 'prepared') throw new Error('Evidence run is already terminal.');
      await verifyRunArtifacts(input, run);
      const activated = {
        ...run,
        managedOperationId: input.managedOperationId,
        inputRevision: input.inputRevision,
      };
      await publishMarker(content, {
        ...document,
        evidenceRuns: document.evidenceRuns?.map((candidate) =>
          candidate.id === run.id ? activated : candidate
        ),
        updatedAt: new Date().toISOString(),
      });
      return activated;
    },
    suppliedContext,
    () => authority.assertCurrent()
  );
}

export async function completeSequenceEvidenceRunInMain(
  input: CompleteSequenceEvidenceRunRequest,
  contextOrAssert?: RegisteredSequencePackagePublicationContext | (() => void),
  assertCurrent?: () => void
): Promise<CompleteSequenceEvidenceRunResult> {
  const suppliedContext = typeof contextOrAssert === 'function' ? undefined : contextOrAssert;
  const authority = createEvidenceInvocationAuthority(
    typeof contextOrAssert === 'function' ? contextOrAssert : assertCurrent
  );
  assertRequest(input);
  return withPublishedSequenceEvidenceMutationInMain(
    input.workspaceRoot,
    input.packageRoot,
    async (publishMarker) => {
      const { markerPath, content, document } = await readMarker(input);
      const run = document.evidenceRuns?.find((candidate) => candidate.id === input.runId);
      if (!run) throw new Error('Prepared evidence run is missing.');
      await verifyRunArtifacts(input, run);
      if (run.status === 'completed') {
        if (
          run.managedOperationId !== input.managedOperationId ||
          run.inputRevision !== input.inputRevision
        ) {
          throw new Error('Completed evidence run belongs to a different operation.');
        }
        const expected = serializeResult(input.result);
        if (run.result?.sha256 !== sha256(Buffer.from(expected))) {
          throw new Error('Completed evidence run cannot be overwritten.');
        }
        return {
          run,
          resultPath: fromPackageRelative(run.result.path, input.packageRoot),
          markerPath,
        };
      }
      if (run.status !== 'prepared') throw new Error('Evidence run is already terminal.');
      if (
        (run.managedOperationId && run.managedOperationId !== input.managedOperationId) ||
        (run.inputRevision && run.inputRevision !== input.inputRevision)
      ) {
        throw new Error('Managed result does not match the activated evidence run.');
      }
      if (input.result.inputRevision !== input.inputRevision) {
        throw new Error('Managed result input revision does not match the retained operation.');
      }
      if (input.result.referenceRevision !== run.reference.sequenceRevision) {
        throw new Error('Managed result reference does not match the frozen package input.');
      }
      const rows = new Map(input.result.results.map((row) => [row.queryId, row]));
      if (rows.size !== run.queries.length) {
        throw new Error('Managed result does not contain every frozen query.');
      }
      for (const query of run.queries) {
        const row = rows.get(query.id);
        if (!row) throw new Error('Managed result query ID does not match frozen input.');
        const path = fromPackageRelative(query.artifact.path, input.packageRoot);
        const bytes = await boundedRead(path);
        const content = isBinarySequencePath(path)
          ? bytes
          : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const sequence = decodeSequenceDocument(content, { path, filename: basename(path) })
          .sequence.sequence;
        if (row.queryRevision !== scientificRevision('pairwise-query', sequence)) {
          throw new Error('Managed result query revision does not match frozen input.');
        }
      }
      const contentBytes = serializeResult(input.result);
      if (Buffer.byteLength(contentBytes, 'utf8') > MAX_EVIDENCE_RESULT_BYTES) {
        throw new Error('Managed result exceeds the package evidence limit.');
      }
      const result: SequencePackageEvidenceArtifact = {
        path: `contents/evidence/${input.runId}/result.json`,
        sha256: sha256(Buffer.from(contentBytes)),
      };
      await writeImmutableBytes(input, result, Buffer.from(contentBytes), authority);
      const completed: SequencePackageEvidenceRun = {
        ...run,
        status: 'completed',
        managedOperationId: input.managedOperationId,
        inputRevision: input.inputRevision,
        result,
        completedAt: new Date().toISOString(),
      };
      await publishMarker(content, {
        ...document,
        members: [
          ...document.members,
          evidenceMember(input.runId, 'result', result, 'evidence-result'),
        ],
        evidenceRuns: document.evidenceRuns?.map((candidate) =>
          candidate.id === input.runId ? completed : candidate
        ),
        updatedAt: new Date().toISOString(),
      });
      return {
        run: completed,
        resultPath: fromPackageRelative(result.path, input.packageRoot),
        markerPath,
      };
    },
    suppliedContext,
    () => authority.assertCurrent()
  );
}

export async function failSequenceEvidenceRunInMain(
  input: FailSequenceEvidenceRunRequest,
  contextOrAssert?: RegisteredSequencePackagePublicationContext | (() => void),
  assertCurrent?: () => void
): Promise<SequencePackageEvidenceRun> {
  const suppliedContext = typeof contextOrAssert === 'function' ? undefined : contextOrAssert;
  const authority = createEvidenceInvocationAuthority(
    typeof contextOrAssert === 'function' ? contextOrAssert : assertCurrent
  );
  assertRequest(input);
  if (input.status !== 'failed' && input.status !== 'canceled' && input.status !== 'interrupted') {
    throw new Error('Evidence failure status is invalid.');
  }
  return withPublishedSequenceEvidenceMutationInMain(
    input.workspaceRoot,
    input.packageRoot,
    async (publishMarker) => {
      const { content, document } = await readMarker(input);
      const run = document.evidenceRuns?.find((candidate) => candidate.id === input.runId);
      if (!run) throw new Error('Prepared evidence run is missing.');
      if (run.status !== 'prepared') {
        if (run.status === input.status && run.managedOperationId === input.managedOperationId)
          return run;
        throw new Error('Evidence run is already terminal.');
      }
      if (
        (run.managedOperationId && run.managedOperationId !== input.managedOperationId) ||
        (run.inputRevision && run.inputRevision !== input.inputRevision)
      ) {
        throw new Error('Evidence failure does not match the activated operation.');
      }
      const failed: SequencePackageEvidenceRun = {
        ...run,
        status: input.status,
        ...(input.managedOperationId ? { managedOperationId: input.managedOperationId } : {}),
        ...(input.inputRevision ? { inputRevision: input.inputRevision } : {}),
        completedAt: new Date().toISOString(),
      };
      await publishMarker(content, {
        ...document,
        evidenceRuns: document.evidenceRuns?.map((candidate) =>
          candidate.id === input.runId ? failed : candidate
        ),
        updatedAt: new Date().toISOString(),
      });
      return failed;
    },
    suppliedContext,
    () => authority.assertCurrent()
  );
}

export async function appendSequenceEvidenceStateInMain(
  input: AppendSequenceEvidenceStateRequest,
  contextOrAssert?: RegisteredSequencePackagePublicationContext | (() => void),
  assertCurrent?: () => void
): Promise<SequencePackageEvidenceRun> {
  const suppliedContext = typeof contextOrAssert === 'function' ? undefined : contextOrAssert;
  const authority = createEvidenceInvocationAuthority(
    typeof contextOrAssert === 'function' ? contextOrAssert : assertCurrent
  );
  assertRequest(input);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.stateId) || input.classifier !== 'mutation-impact-v1') {
    throw new Error('Evidence state identity is invalid.');
  }
  return withPublishedSequenceEvidenceMutationInMain(
    input.workspaceRoot,
    input.packageRoot,
    async (publishMarker) => {
      const { content, document } = await readMarker(input);
      const run = document.evidenceRuns?.find((candidate) => candidate.id === input.runId);
      if (!run || run.status !== 'completed' || !run.result) {
        throw new Error('Only a completed evidence run can be reviewed.');
      }
      await verifyRunArtifacts(input, run);
      if (input.tracks.length !== run.queries.length) {
        throw new Error('Evidence state must include every query in the run.');
      }
      if (
        input.session &&
        (!input.session.name.trim() ||
          !input.session.createdAt ||
          (input.session.mode !== 'one-per-clone' && input.session.mode !== 'multi-per-clone') ||
          typeof input.session.archived !== 'boolean')
      ) {
        throw new Error('Evidence session review state is invalid.');
      }
      const rawResult = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          Uint8Array.from(
            await boundedRead(fromPackageRelative(run.result.path, input.packageRoot))
          )
        )
      ) as {
        results?: Array<{
          queryId: string;
          alignment?: {
            aligned_reference?: string;
            aligned_query?: string;
            identity?: number;
            circular_offset?: number;
            reference_length?: number;
          };
        }>;
      };
      const rawRows = new Map(rawResult.results?.map((row) => [row.queryId, row]) ?? []);
      const referencePath = fromPackageRelative(run.reference.artifact.path, input.packageRoot);
      const referenceBytes = Uint8Array.from(await boundedRead(referencePath));
      const referenceSequence = decodeSequenceDocument(
        isBinarySequencePath(referencePath)
          ? referenceBytes
          : new TextDecoder('utf-8', { fatal: true }).decode(referenceBytes),
        { path: referencePath, filename: basename(referencePath) }
      ).sequence.sequence;
      const stateTracks = run.queries.map((query) => {
        const track = input.tracks.find((candidate) => candidate.queryId === query.id);
        const raw = rawRows.get(query.id)?.alignment;
        const legacyFull =
          raw?.aligned_reference?.replace(/-/g, '').toUpperCase() ===
            referenceSequence.toUpperCase() &&
          (raw?.circular_offset === undefined || raw.circular_offset === 0);
        const observation =
          typeof raw?.aligned_reference === 'string' && typeof raw.aligned_query === 'string'
            ? interpretReferenceAlignment(
                {
                  alignedReference: raw.aligned_reference,
                  alignedQuery: raw.aligned_query,
                  circularOffset: raw.circular_offset,
                  referenceLength:
                    raw.reference_length ?? (legacyFull ? referenceSequence.length : undefined),
                },
                { sequence: referenceSequence, topology: run.reference.topology }
              )
            : null;
        const placementMatches =
          observation?.kind === 'placed' &&
          ((legacyFull &&
            track?.alignment?.circularOffset === undefined &&
            track?.alignment?.referenceLength === undefined) ||
            (track?.alignment?.circularOffset === observation.value.circularOffset &&
              track?.alignment?.referenceLength === observation.value.referenceLength));
        if (
          !track ||
          !raw ||
          track.alignment?.alignedReference !== raw.aligned_reference ||
          track.alignment?.alignedQuery !== raw.aligned_query ||
          track.alignment?.identity !== raw.identity ||
          !placementMatches ||
          !Array.isArray(track.mutations) ||
          !['pass', 'variants', 'fail', 'incomplete'].includes(track.status) ||
          (track.userStatus !== undefined &&
            !['pass', 'variants', 'fail', 'incomplete'].includes(track.userStatus)) ||
          (track.checkedMutations !== undefined && !Array.isArray(track.checkedMutations))
        ) {
          throw new Error('Evidence state does not match the retained producer result.');
        }
        return track;
      });
      const stateContent = `${JSON.stringify(
        {
          schema: 'waypoint.sequence-evidence-state.v1',
          runId: run.id,
          classifier: input.classifier,
          ...(input.session ? { session: input.session } : {}),
          tracks: stateTracks,
        },
        null,
        2
      )}\n`;
      if (Buffer.byteLength(stateContent, 'utf8') > MAX_EVIDENCE_RESULT_BYTES) {
        throw new Error('Evidence state exceeds the package limit.');
      }
      const digest = sha256(Buffer.from(stateContent));
      const prior = run.states?.find((state) => state.id === input.stateId);
      if (prior) {
        if (prior.artifact.sha256 !== digest) {
          throw new Error('Evidence state ID is already bound to different content.');
        }
        return run;
      }
      if (run.states?.at(-1)?.artifact.sha256 === digest) return run;
      const artifact: SequencePackageEvidenceArtifact = {
        path: `contents/evidence/${run.id}/state-${input.stateId}.json`,
        sha256: digest,
      };
      await writeImmutableBytes(input, artifact, Buffer.from(stateContent), authority);
      const nextRun: SequencePackageEvidenceRun = {
        ...run,
        states: [
          ...(run.states ?? []),
          { id: input.stateId, createdAt: new Date().toISOString(), artifact },
        ],
      };
      await publishMarker(content, {
        ...document,
        members: [
          ...document.members,
          evidenceMember(run.id, `state-${input.stateId}`, artifact, 'evidence-result'),
        ],
        evidenceRuns: document.evidenceRuns?.map((candidate) =>
          candidate.id === run.id ? nextRun : candidate
        ),
        updatedAt: new Date().toISOString(),
      });
      return nextRun;
    },
    suppliedContext,
    () => authority.assertCurrent()
  );
}

export async function publishSequenceAlignmentHistoryInMain(
  input: PublishSequenceAlignmentHistoryRequest,
  contextOrAssert?: RegisteredSequencePackagePublicationContext | (() => void),
  assertCurrent?: () => void
): Promise<string> {
  const suppliedContext = typeof contextOrAssert === 'function' ? undefined : contextOrAssert;
  const authority = createEvidenceInvocationAuthority(
    typeof contextOrAssert === 'function' ? contextOrAssert : assertCurrent
  );
  if (
    !input.packageId ||
    typeof input.content !== 'string' ||
    Buffer.byteLength(input.content) > MAX_EVIDENCE_RESULT_BYTES
  )
    throw new Error('Alignment history exceeds its saved package limit.');
  const nextValue: unknown = JSON.parse(input.content);
  if (!nextValue || typeof nextValue !== 'object' || Array.isArray(nextValue))
    throw new Error('Alignment history must be a saved object.');
  return withPublishedSequenceEvidenceMutationInMain(
    input.workspaceRoot,
    input.packageRoot,
    async (publishMarker) => {
      const { content, document } = await readMarker(input);
      const current = document.members.find((member) => member.role === 'alignment');
      if (current) {
        const safe = await canonicalWorkspacePath({
          workspaceRoot: input.packageRoot,
          path: fromPackageRelative(current.path, input.packageRoot),
          artifactNoun: 'alignment history',
        });
        const bytes = await boundedRead(safe.candidate);
        const expected = current.path.match(
          /^contents\/alignment-history-([a-f0-9]{64})\.json$/
        )?.[1];
        if (expected && sha256(bytes) !== `sha256:${expected}`)
          throw new Error('The current saved alignment history failed integrity verification.');
        const previous: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
        if (
          previous &&
          typeof previous === 'object' &&
          !Array.isArray(previous) &&
          JSON.stringify({ ...previous, savedAt: null }) ===
            JSON.stringify({ ...nextValue, savedAt: null })
        )
          return fromPackageRelative(current.path, input.packageRoot);
      }
      const members: SequencePackageMember[] = [];
      for (const member of document.members) {
        if (member.role !== 'alignment') {
          members.push(member);
          continue;
        }
        const safe = await canonicalWorkspacePath({
          workspaceRoot: input.packageRoot,
          path: fromPackageRelative(member.path, input.packageRoot),
          artifactNoun: 'alignment history',
        });
        const bytes = await boundedRead(safe.candidate);
        const digest = sha256(bytes);
        const expected = member.path.match(
          /^contents\/alignment-history-([a-f0-9]{64})\.json$/
        )?.[1];
        if (expected && digest !== `sha256:${expected}`)
          throw new Error('A retained alignment history failed integrity verification.');
        const artifact = {
          path: `contents/alignment-history-${digest.slice(7)}.json`,
          sha256: digest,
        };
        await writeImmutableBytes(input, artifact, bytes, authority);

        members.push({ ...member, path: artifact.path, replaceable: false });
      }
      const digest = sha256(Buffer.from(input.content));
      const artifact = {
        path: `contents/alignment-history-${digest.slice(7)}.json`,
        sha256: digest,
      };
      await writeImmutableBytes(input, artifact, Buffer.from(input.content), authority);
      const member = members.find(
        (candidate) => candidate.role === 'alignment' && candidate.path === artifact.path
      ) ?? {
        id: `alignment:${digest.slice(7)}`,
        role: 'alignment',
        path: artifact.path,
        replaceable: false,
        createdAt: new Date().toISOString(),
      };
      await publishMarker(content, {
        ...document,
        members: [member, ...members.filter((candidate) => candidate.path !== artifact.path)],
        updatedAt: new Date().toISOString(),
      });
      return fromPackageRelative(artifact.path, input.packageRoot);
    },
    suppliedContext,
    () => authority.assertCurrent()
  );
}

function assertRequest(input: { packageRoot: string; packageId: string; runId: string }): void {
  if (!input.packageRoot || !input.packageId || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.runId)) {
    throw new Error('Evidence package identity is invalid.');
  }
}

async function readMarker(input: {
  workspaceRoot: string;
  packageRoot: string;
  packageId: string;
}): Promise<{
  markerPath: string;
  content: string;
  document: SequencePackageDocument;
}> {
  const markerPath = sequencePackagePaths(input.packageRoot).metaPath;
  const safe = await canonicalWorkspacePath({
    workspaceRoot: input.workspaceRoot,
    path: markerPath,
    artifactNoun: 'sequence evidence',
  });
  const accepted = readAcceptedSequencePackageBytes(markerPath);
  const content = accepted
    ? new TextDecoder('utf-8', { fatal: true }).decode(accepted)
    : await readFile(safe.candidate, 'utf8');
  const document = parseSequencePackageDocument(content);
  if (document.id !== input.packageId) throw new Error('Evidence package ID changed.');
  return { markerPath, content, document };
}

async function boundedRead(path: string): Promise<Uint8Array> {
  const accepted = readAcceptedSequencePackageBytes(path);
  if (accepted) {
    if (accepted.byteLength > MAX_SEQUENCE_EVIDENCE_INPUT_BYTES)
      throw new Error('Evidence input must be a file below the package limit.');
    return accepted;
  }
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_SEQUENCE_EVIDENCE_INPUT_BYTES) {
    throw new Error('Evidence input must be a file below the package limit.');
  }
  return readFile(path);
}

async function writeImmutableBytes(
  input: { workspaceRoot: string; packageRoot: string },
  artifact: SequencePackageEvidenceArtifact,
  bytes: Uint8Array,
  authority: EvidenceInvocationAuthority
): Promise<void> {
  const path = fromPackageRelative(artifact.path, input.packageRoot);
  if (sha256(bytes) !== artifact.sha256)
    throw new Error('Prepared evidence artifact bytes do not match their digest.');
  if (await stageAcceptedSequencePackageFile({ ...input, path, content: bytes })) return;
  const safe = await canonicalWorkspacePath({
    workspaceRoot: input.workspaceRoot,
    path,
    allowMissing: true,
    artifactNoun: 'sequence evidence',
  });
  try {
    const existing = await readFile(safe.candidate);
    if (sha256(existing) !== artifact.sha256) {
      throw new Error(`Immutable evidence artifact conflicts at ${artifact.path}.`);
    }
    return;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  await writeWorkspaceBinaryFileAtomicInMain(
    {
      workspaceRoot: input.workspaceRoot,
      path,
      content: bytes,
      artifactNoun: 'sequence evidence',
    },
    { beforePublish: () => authority.assertCurrent() }
  );
  authority.recordNewImmutableWrite();
  if (sha256(await readFile(safe.candidate)) !== artifact.sha256) {
    throw new Error(`Sequence evidence could not be verified at ${artifact.path}.`);
  }
}

async function verifyRunArtifacts(
  input: { workspaceRoot: string; packageRoot: string },
  run: SequencePackageEvidenceRun
): Promise<void> {
  const artifacts = [
    run.reference.artifact,
    ...run.queries.map((query) => query.artifact),
    ...(run.result ? [run.result] : []),
    ...(run.states?.map((state) => state.artifact) ?? []),
  ];
  for (const artifact of artifacts) {
    const path = fromPackageRelative(artifact.path, input.packageRoot);
    const safe = await canonicalWorkspacePath({
      workspaceRoot: input.workspaceRoot,
      path,
      artifactNoun: 'sequence evidence',
    });
    if (sha256(await boundedRead(safe.candidate)) !== artifact.sha256) {
      throw new Error(`Sequence evidence failed integrity verification: ${artifact.path}.`);
    }
  }
}

function preparedReceipt(
  input: { packageRoot: string },
  run: SequencePackageEvidenceRun,
  markerPath: string,
  attachedQueryPaths: Record<string, string> = {}
): PrepareSequenceEvidenceRunResult {
  return {
    run,
    referenceReadPath: fromPackageRelative(run.reference.artifact.path, input.packageRoot),
    queryPaths: Object.fromEntries(
      run.queries.map((query) => [
        query.id,
        fromPackageRelative(query.artifact.path, input.packageRoot),
      ])
    ),
    markerPath,
    attachedQueryPaths,
  };
}

function evidenceMember(
  runId: string,
  name: string,
  artifact: SequencePackageEvidenceArtifact,
  role: 'evidence-input' | 'evidence-result'
): SequencePackageMember {
  return {
    id: `evidence:${runId}:${name}`,
    role,
    path: artifact.path,
    replaceable: false,
    createdAt: new Date().toISOString(),
  };
}

function scientificRevision(
  prefix: 'pairwise-reference' | 'pairwise-query',
  sequence: string
): string {
  return `${prefix}-v1:${sha256(Buffer.from(JSON.stringify(sequence.replace(/\s/g, '').toUpperCase())))}`;
}

function serializeResult(result: CompleteSequenceEvidenceRunRequest['result']): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
