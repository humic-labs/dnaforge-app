import { computeChecksum } from '@waypoint/sequence-utils';
import type { SequenceDesign } from './types';

export async function packageAssemblyWorkingCopyDesignId(
  constructId: string,
  acceptedAssemblyVersionId: string
): Promise<string> {
  const checksum = await computeChecksum(
    JSON.stringify({ constructId, acceptedAssemblyVersionId })
  );
  return `draft-${checksum.slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

export function isPackageAssemblyWorkingCopyDesign(design: SequenceDesign): boolean {
  return Boolean(
    design.constructId &&
    design.parentAcceptedAssemblyVersionId &&
    /^draft-[a-f0-9]{32}$/.test(design.id)
  );
}
