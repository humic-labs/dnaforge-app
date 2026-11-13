import type {
  ReferenceCompatibilityReceipt,
  TextIntervalReferenceExtent,
} from '@waypoint/genome-data';
import { computeChecksum } from '@waypoint/sequence-utils';

import { referenceSignature, type ReferenceIdentity } from './bbi-reference-compatibility';
import { buildContigNameMap } from './contig-name-map';

export async function assertTextIntervalReferencesCompatible(input: {
  readonly assemblyId: string;
  readonly expected: ReadonlyArray<ReferenceIdentity>;
  readonly actual: ReadonlyArray<TextIntervalReferenceExtent>;
  readonly checkedAt?: string;
  readonly formatName: string;
}): Promise<ReferenceCompatibilityReceipt> {
  if (input.expected.length === 0) {
    throw new Error('The reference assembly has no chromosome identity to verify this track.');
  }
  const naming = buildContigNameMap({
    assembly: input.expected,
    source: input.actual.map((extent) => ({ name: extent.name })),
  });

  if (naming.unmatchedSource.length > 0) {
    throw new Error(
      `${input.formatName} reference ${naming.unmatchedSource[0]} is not present in ${input.assemblyId}.`
    );
  }
  if (naming.ambiguousSource.length > 0) {
    throw new Error(
      `${input.formatName} reference ${naming.ambiguousSource[0]} maps ambiguously in ${input.assemblyId}.`
    );
  }

  const lengthByAssemblyName = new Map(
    input.expected.map((reference) => [reference.name, reference.length])
  );
  const contigMap: Record<string, string> = {};
  for (const extent of input.actual) {
    const match = naming.matchForSource(extent.name.trim());
    if (!match) continue;
    const length = lengthByAssemblyName.get(match.assemblyName) ?? 0;
    if (extent.maxEnd > length) {
      throw new Error(
        `${input.formatName} reference mismatch for ${extent.name}: coordinate ${extent.maxEnd} exceeds length ${length}.`
      );
    }
    contigMap[match.assemblyName] = match.sourceName;
  }

  return {
    assemblyId: input.assemblyId,
    referenceSignature: await referenceSignature(input.expected),
    sourceSignature: await textIntervalSourceSignature(input.actual),
    contigMap,
    checkedContigs: input.actual.length,
    status: 'compatible',
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
}

async function textIntervalSourceSignature(
  extents: ReadonlyArray<TextIntervalReferenceExtent>
): Promise<string> {
  const canonical = [...extents]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((extent) => `${extent.name}\u0000${extent.maxEnd}`)
    .join('\u0001');
  return computeChecksum(`dnaforge:text-interval-reference-extents:v1\u0000${canonical}`);
}
