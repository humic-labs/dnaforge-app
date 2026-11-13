import { readFile, realpath } from 'node:fs/promises';

import {
  unpackPrepackedAnnotationSearchIndexV1,
  unpackPrepackedProteinSearchIndexV1,
  visitPrepackedAnnotationSearchResultIdentitiesV1,
  visitPrepackedProteinSearchResultIdentitiesV1,
  type PrepackedAnnotationSearchIndexManifestV1,
  type PrepackedProteinSearchIndexManifestV1,
  type PrepackedSearchResultIdentityV1,
} from '@waypoint/genome-data';

import { sha256BoundedNodeV1 } from '../ipc/bounded-binary-sha256';

const WORKER_CONTRACT = 'portable-prepared-reference-search-admission-worker.v1' as const;
const SHA256 = /^[0-9a-f]{64}$/;

interface PortableSearchAdmissionWorkerJobBaseV1 {
  readonly contract: typeof WORKER_CONTRACT;
  readonly payloadPath: string;
  readonly authorizedPayloadRealPath: string;
  readonly admittedAnnotationTrackIds: readonly string[];
}

export type PortablePreparedReferenceSearchAdmissionWorkerJobV1 =
  | Readonly<
      PortableSearchAdmissionWorkerJobBaseV1 & {
        readonly kind: 'annotation';
        readonly manifest: PrepackedAnnotationSearchIndexManifestV1;
      }
    >
  | Readonly<
      PortableSearchAdmissionWorkerJobBaseV1 & {
        readonly kind: 'protein';
        readonly manifest: PrepackedProteinSearchIndexManifestV1;
      }
    >;

export type PortablePreparedReferenceSearchAdmissionWorkerResultV1 = Readonly<{
  contract: typeof WORKER_CONTRACT;
  kind: 'annotation' | 'protein';
  byteCount: number;
  featureCount: number;
}>;

export interface PortablePreparedReferenceSearchAdmissionWorkerJobDepsV1 {
  readonly resolveRealPath?: typeof realpath;
  readonly readPayload?: (path: string) => Promise<Uint8Array>;
}

export async function runPortablePreparedReferenceSearchAdmissionWorkerJobV1(
  job: PortablePreparedReferenceSearchAdmissionWorkerJobV1,
  deps: PortablePreparedReferenceSearchAdmissionWorkerJobDepsV1 = {}
): Promise<PortablePreparedReferenceSearchAdmissionWorkerResultV1> {
  validateWorkerEnvelope(job);
  const currentRealPath = await (deps.resolveRealPath ?? realpath)(job.payloadPath);
  if (currentRealPath !== job.authorizedPayloadRealPath) {
    throw new Error('Portable search admission worker rejected a changed payload path.');
  }
  const payload = await (deps.readPayload ?? (async (path: string) => readFile(path)))(
    job.payloadPath
  );
  if (!(payload instanceof Uint8Array) || payload.byteLength !== job.manifest.byteLength) {
    throw new Error('Portable search admission worker rejected a truncated payload.');
  }

  const admittedTrackIds = new Set(job.admittedAnnotationTrackIds);
  if (job.kind === 'annotation') {
    const search = await unpackPrepackedAnnotationSearchIndexV1(
      job.manifest,
      payload,
      sha256BoundedNodeV1
    );
    visitPrepackedAnnotationSearchResultIdentitiesV1(search, (identity) => {
      assertPortableSearchResultIdentity(identity, admittedTrackIds);
    });
  } else {
    const search = await unpackPrepackedProteinSearchIndexV1(
      job.manifest,
      payload,
      sha256BoundedNodeV1
    );
    visitPrepackedProteinSearchResultIdentitiesV1(search, (identity) => {
      assertPortableSearchResultIdentity(identity, admittedTrackIds);
    });
  }

  return Object.freeze({
    contract: WORKER_CONTRACT,
    kind: job.kind,
    byteCount: payload.byteLength,
    featureCount: job.manifest.featureCount,
  });
}

function validateWorkerEnvelope(job: PortablePreparedReferenceSearchAdmissionWorkerJobV1): void {
  if (
    job?.contract !== WORKER_CONTRACT ||
    (job.kind !== 'annotation' && job.kind !== 'protein') ||
    typeof job.payloadPath !== 'string' ||
    job.payloadPath.trim().length === 0 ||
    typeof job.authorizedPayloadRealPath !== 'string' ||
    job.authorizedPayloadRealPath.trim().length === 0 ||
    !job.manifest ||
    !Number.isSafeInteger(job.manifest.byteLength) ||
    job.manifest.byteLength < 0 ||
    !SHA256.test(job.manifest.integrity?.payloadSha256 ?? '') ||
    !Array.isArray(job.admittedAnnotationTrackIds) ||
    job.admittedAnnotationTrackIds.length === 0 ||
    new Set(job.admittedAnnotationTrackIds).size !== job.admittedAnnotationTrackIds.length ||
    job.admittedAnnotationTrackIds.some(
      (trackId) => typeof trackId !== 'string' || trackId.trim().length === 0
    )
  ) {
    throw new Error('Portable search admission worker rejected an invalid job envelope.');
  }
}

export function assertPortableSearchResultIdentity(
  identity: PrepackedSearchResultIdentityV1,
  admittedAnnotationTrackIds: ReadonlySet<string>
): void {
  let canonical: unknown;
  try {
    canonical = JSON.parse(identity.canonicalIdentity);
  } catch {
    throw new Error('Portable search canonical annotation identity is invalid.');
  }
  if (
    !admittedAnnotationTrackIds.has(identity.annotationTrackId) ||
    !Array.isArray(canonical) ||
    canonical.length !== 9 ||
    canonical[0] !== 'annotation.v2' ||
    typeof canonical[1] !== 'string' ||
    canonical[1].length === 0 ||
    typeof canonical[2] !== 'string' ||
    canonical[2].length === 0 ||
    (canonical[3] !== null && (typeof canonical[3] !== 'string' || canonical[3].length === 0)) ||
    canonical[4] !== identity.annotationTrackId ||
    typeof canonical[5] !== 'string' ||
    canonical[5].length === 0 ||
    !Number.isSafeInteger(canonical[6]) ||
    !Number.isSafeInteger(canonical[7]) ||
    canonical[6] < 0 ||
    canonical[7] <= canonical[6] ||
    (canonical[8] !== 'forward' && canonical[8] !== 'reverse' && canonical[8] !== 'none')
  ) {
    throw new Error('Portable search result is not owned by the admitted annotation roster.');
  }
}

export function portablePreparedReferenceSearchAdmissionWorkerContractV1(): typeof WORKER_CONTRACT {
  return WORKER_CONTRACT;
}
