import {
  isIndexedBbiTrackSource,
  requireTrackAdmissionRequest,
  type AdmittedTrackSource,
} from '@waypoint/genome-data';
import { platform } from '../../platform';
import { INTERNAL_TRACK_FIXTURES } from '../../shared/internal-track-fixtures';
import type { AlignmentReferenceIdentity } from './alignment-header-client';
import { admitIndexedBigWigRequest } from './indexed-track-admission';

export async function recoverScenarioTrackSource(
  source: AdmittedTrackSource,
  assemblyReferences: readonly AlignmentReferenceIdentity[],
  signal?: AbortSignal
): Promise<AdmittedTrackSource> {
  const path =
    isIndexedBbiTrackSource(source) && source.input?.kind === 'path' ? source.input.path : null;
  const fixture =
    path && source.provenance.devScenarioFixture && source.formatId === 'bigwig'
      ? Object.values(INTERNAL_TRACK_FIXTURES).find(
          (item) =>
            path.replace(/\\/g, '/').endsWith(`/${item.relativePath}`) &&
            source.expectedValidators?.contentLength === item.sizeBytes
        )
      : undefined;
  if (!fixture || !path || !(await platform().path.projectRoot())) return source;
  if (signal?.aborted) throw new DOMException('Track view recovery cancelled', 'AbortError');
  const retained = await platform().internalFixtures.recoverTrack({
    relativePath: fixture.relativePath,
    previousPath: path,
  });
  if (signal?.aborted) throw new DOMException('Track view recovery cancelled', 'AbortError');
  if (!retained.path) return source;
  const request = requireTrackAdmissionRequest(source);
  return admitIndexedBigWigRequest({
    request: { ...request, source: { kind: 'local-file', path: retained.path } },
    assemblyReferences,
    signal,
  });
}
