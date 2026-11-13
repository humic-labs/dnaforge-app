import {
  hostedReferenceUcscTrackTargetForAssembly,
  type HostedReferenceUcscTrackTargetV1,
} from '../../shared/hosted-reference-ucsc-targets';

export function ucscTrackTargetForAssembly(
  assemblyId: string
): HostedReferenceUcscTrackTargetV1 | null {
  return hostedReferenceUcscTrackTargetForAssembly(assemblyId);
}

export type { HostedReferenceUcscTrackTargetV1 };
