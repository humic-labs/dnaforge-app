import {
  trackAdmissionRequestLabel,
  type AdmittedTrackSource,
  type TrackAdmissionRequestV1,
} from '@waypoint/genome-data';

import type { IndexedGenomeVariantSourceState } from '../../shared/indexed-genome';
import type { HtsgetRuntime } from './htsget-client';
import type { LocalVariantRuntime, VariantTrackRuntime } from './variant-track-admission';

export function durableVariantSource(
  admitted: AdmittedTrackSource,
  runtime: VariantTrackRuntime
): IndexedGenomeVariantSourceState {
  const request = requireVariantRequest(admitted);
  if (request.source.kind === 'local-file') {
    if (
      admitted.readerKind !== 'variant' ||
      admitted.scientificKind !== 'variants' ||
      admitted.input?.kind !== 'path' ||
      (admitted.formatId !== 'vcf' && admitted.formatId !== 'bcf') ||
      !isLocalVariantRuntime(runtime) ||
      runtime.prepared.format !== admitted.formatId ||
      runtime.prepared.sourcePath !== admitted.input.path
    ) {
      throw new Error('Local variant admission returned an incomplete durable receipt.');
    }
    return {
      ...runtime.prepared,
      label: admitted.provenance.label ?? trackAdmissionRequestLabel(request),
      admittedSource: admitted,
      matchedReferences: [...runtime.matchedReferences],
      samples: [...runtime.samples],
      attachedAt: Date.now(),
    };
  }
  if (request.source.kind === 'htsget') {
    if (
      admitted.readerKind !== 'variant' ||
      admitted.scientificKind !== 'variants' ||
      (admitted.formatId !== 'vcf' && admitted.formatId !== 'bcf') ||
      !isHtsgetVariantRuntime(runtime) ||
      runtime.dataClass !== 'variants' ||
      runtime.format.toLowerCase() !== admitted.formatId ||
      admitted.uri !== `htsget:${runtime.sourceIdentity}`
    ) {
      throw new Error('htsget variant admission returned an incomplete durable receipt.');
    }
    const sourcePath = `htsget-source://${runtime.sourceIdentity}/source.${admitted.formatId}`;
    return {
      sourcePath,
      queryPath: sourcePath,
      indexPath: `htsget-source://${runtime.sourceIdentity}/regional-index`,
      format: admitted.formatId,
      label: admitted.provenance.label ?? trackAdmissionRequestLabel(request),
      sourceSizeBytes: 0,
      sourceIdentity: runtime.sourceIdentity,
      assemblyRevision: runtime.assemblyRevision,
      admittedSource: admitted,
      matchedReferences: [...runtime.matchedReferences],
      samples: [...runtime.samples],
      attachedAt: Date.now(),
    };
  }
  if (
    admitted.readerKind !== 'variant' ||
    admitted.scientificKind !== 'variants' ||
    admitted.input?.kind !== 'url' ||
    admitted.index?.kind !== 'url' ||
    (admitted.formatId !== 'vcf' && admitted.formatId !== 'bcf') ||
    admitted.expectedValidators?.contentLength === undefined
  ) {
    throw new Error('Remote variant admission returned an incomplete durable receipt.');
  }
  return {
    sourcePath: admitted.input.url,
    queryPath: admitted.input.url,
    indexPath: admitted.index.url,
    format: admitted.formatId,
    label: admitted.provenance.label ?? trackAdmissionRequestLabel(request),
    sourceSizeBytes: admitted.expectedValidators.contentLength,
    sourceIdentity: runtime.sourceIdentity,
    assemblyRevision: runtime.assemblyRevision,
    admittedSource: admitted,
    matchedReferences: [...runtime.matchedReferences],
    samples: [...runtime.samples],
    attachedAt: Date.now(),
  };
}

export function requireVariantRequest(source: AdmittedTrackSource): TrackAdmissionRequestV1 {
  if (source.admissionVersion !== 2 || !source.request) {
    throw new Error('The saved mutation source must be linked again.');
  }
  return source.request;
}

export function isHtsgetVariantRuntime(runtime: VariantTrackRuntime): runtime is HtsgetRuntime {
  return 'kind' in runtime && runtime.kind === 'htsget';
}

export function isLocalVariantRuntime(
  runtime: VariantTrackRuntime
): runtime is LocalVariantRuntime {
  return 'kind' in runtime && runtime.kind === 'local';
}
