import { useEffect, useState } from 'react';
import {
  decodeSequenceDocument,
  reverseComplement,
  type TraceData,
} from '@waypoint/sequence-utils';
import { userMessage } from '@waypoint/user-messages';
import { useToastStore } from '../../../stores/toast-store';
import { rotateTrace, reverseComplementTrace } from '../../trace/public';
import { platform } from '../../../platform';
import { sha256Hex } from '../../../shared/sha256-sync';
import {
  retainedEvidencePaths,
  resolveAlignmentQueryPath,
  type VerificationTrack,
} from '../../alignment-manager/public/trace-source';
import { buildAlignedChromatogramOptions } from '../tracks/aligned-chromatogram';
import type { ChromatogramLaneOptions } from '../tracks/chromatogram-lane';

type TraceRows = ReadonlyMap<string, ChromatogramLaneOptions>;
const empty: TraceRows = new Map();

export function useAlignmentTraces(
  referencePath: string,
  reference: string,
  tracks: readonly VerificationTrack[]
): TraceRows {
  const [loaded, setLoaded] = useState<{
    tracks: readonly VerificationTrack[];
    referencePath: string;
    reference: string;
    rows: TraceRows;
  }>();
  useEffect(() => {
    let active = true;
    const sources = tracks.filter((track) => /\.(ab1|abi)$/i.test(track.queryPath));
    if (!sources.length || !reference) return;
    const runs = new Map<string, ReturnType<typeof retainedEvidencePaths>>();
    const load = async (track: VerificationTrack): Promise<[string, ChromatogramLaneOptions]> => {
      let source = resolveAlignmentQueryPath(track.queryPath, referencePath);
      let expectedHash: string | undefined;
      if (track.evidenceRunId) {
        const paths =
          runs.get(track.evidenceRunId) ??
          retainedEvidencePaths(referencePath, track.evidenceRunId);
        runs.set(track.evidenceRunId, paths);
        const run = await paths;
        const frozen = run.queryPaths.get(track.id);
        expectedHash = run.queryHashes.get(track.id);
        if (!frozen || !expectedHash)
          throw new Error('The saved alignment has no trace for this read.');
        source = frozen;
      }
      const bytes = await platform().fs.readFile(source);
      if (expectedHash && expectedHash !== `sha256:${sha256Hex(bytes)}`)
        throw new Error('The saved trace has changed.');
      const { sequence: read } = decodeSequenceDocument(bytes, {
        path: source,
      });
      const trace = read.metadata?.trace as TraceData | undefined;
      if (!trace) throw new Error('No chromatogram was recorded for this read.');
      const alignment = track.alignment;
      const calls = alignment.alignedQuery.replace(/-/g, '').toUpperCase();
      const forward = read.sequence.toUpperCase();
      const opposite = reverseComplement(forward);
      let reverse = calls !== forward && calls === opposite;
      let start = 0;
      if (calls !== forward && calls !== opposite) {
        if (calls.length !== forward.length || track.testedReference?.topology !== 'circular')
          throw new Error('The saved read no longer matches its alignment.');
        const origins = [forward, opposite].map((sequence) => {
          const doubled = sequence + sequence;
          const first = doubled.indexOf(calls);
          const next = doubled.indexOf(calls, first + 1);
          return first >= 0 && (next < 0 || next >= sequence.length) ? first : -1;
        });
        if (origins[0] >= 0 === origins[1] >= 0)
          throw new Error('The original read origin cannot be resolved.');
        reverse = origins[1] >= 0;
        start = reverse ? origins[1] : origins[0];
      }
      const sourceBaseIndices = trace.peakPositions.map((_, index) => {
        const oriented = (index + start) % calls.length;
        return reverse ? calls.length - oriented - 1 : oriented;
      });
      const orientedTrace = rotateTrace(reverse ? reverseComplementTrace(trace) : trace, start);
      const matchedReference = alignment.alignedReference.replace(/-/g, '').toUpperCase();
      const doubled = (reference + reference).toUpperCase();
      const offset = alignment.referenceOffset ?? doubled.indexOf(matchedReference);
      if (
        offset < 0 ||
        offset >= reference.length ||
        doubled.slice(offset, offset + matchedReference.length) !== matchedReference
      )
        throw new Error('The saved alignment no longer matches its reference.');
      const { laneOptions } = buildAlignedChromatogramOptions({
        referenceSequence: reference,
        trace: orientedTrace,
        readSequence: calls,
        readQuality: read.quality?.length
          ? sourceBaseIndices.map((i) => read.quality![i])
          : undefined,
        alignedQuery: alignment.alignedQuery,
        alignedReference: alignment.alignedReference,
        referenceOffset: offset,
      });
      return [
        track.id,
        {
          ...laneOptions,
          sourceBaseIndices,
          sourcePeakPositions: sourceBaseIndices.map((i) => trace.peakPositions[i]),
          cycleLength:
            offset + matchedReference.length > reference.length ? reference.length : undefined,
        },
      ];
    };
    void Promise.allSettled(sources.map(load)).then((results) => {
      if (!active) return;
      const rows = new Map<string, ChromatogramLaneOptions>();
      for (const result of results) {
        if (result.status === 'fulfilled') rows.set(...result.value);
        else console.warn('Could not load the aligned chromatogram.', result.reason);
      }
      if (results.some((result) => result.status === 'rejected')) {
        useToastStore.getState().addToast(userMessage('readDetails.sourceUnavailable'), {
          definition: 'alignment-trace-unavailable',
        });
      }
      setLoaded({ tracks, reference, referencePath, rows });
    });
    return () => {
      active = false;
    };
  }, [tracks, reference, referencePath]);
  return loaded?.tracks === tracks &&
    loaded.reference === reference &&
    loaded.referencePath === referencePath
    ? loaded.rows
    : empty;
}
