import type { ReferenceCompatibilityReceipt } from '@waypoint/genome-data';
import { computeChecksum } from '@waypoint/sequence-utils';

import type { BbiReferenceInfo } from './bbi-reader-worker-protocol';
import { buildContigNameMap } from './contig-name-map';

export interface ReferenceIdentity {
  readonly name: string;
  readonly length: number;
  readonly aliases?: ReadonlyArray<string>;
}

export async function assertBbiReferencesCompatible(input: {
  readonly assemblyId: string;
  readonly expected: ReadonlyArray<ReferenceIdentity>;
  readonly actual: ReadonlyArray<BbiReferenceInfo>;
  readonly checkedAt?: string;
  readonly formatName?: 'BigWig' | 'BigBed';
  readonly allowSourceSubset?: boolean;
}): Promise<ReferenceCompatibilityReceipt> {
  const naming = buildContigNameMap({ assembly: input.expected, source: input.actual });
  const formatName = input.formatName ?? 'BigWig';

  if (input.allowSourceSubset && naming.matches.length === 0) {
    throw new Error(`${formatName} has no reference contig in common with ${input.assemblyId}.`);
  }
  const missing = naming.unmatchedAssembly[0];
  if (!input.allowSourceSubset && missing !== undefined) {
    throw new Error(
      `${formatName} reference mismatch for ${missing}: ` +
        `expected ${expectedLength(input.expected, missing)}, received missing.`
    );
  }
  const conflicted = naming.matches.find((match) => match.lengthConflict);
  if (conflicted?.lengthConflict) {
    throw new Error(
      `${formatName} reference mismatch for ${conflicted.assemblyName}: ` +
        `expected ${conflicted.lengthConflict.assembly}, received ${conflicted.lengthConflict.source}.`
    );
  }

  return {
    assemblyId: input.assemblyId,
    referenceSignature: await referenceSignature(input.expected),
    sourceSignature: await referenceSignature(input.actual),
    contigMap: Object.fromEntries(
      naming.matches.map((match) => [match.assemblyName, match.sourceName])
    ),
    checkedContigs: naming.matches.length,
    status: 'compatible',
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };
}

function expectedLength(expected: ReadonlyArray<ReferenceIdentity>, name: string): number | string {
  return expected.find((reference) => reference.name === name)?.length ?? 'unknown';
}

export async function referenceSignature(
  references: ReadonlyArray<ReferenceIdentity>
): Promise<string> {
  const canonicalReferences = [...references]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((reference) => `${reference.name}\u0000${reference.length}`)
    .join('\u0001');
  return computeChecksum(`dnaforge:bbi-reference-signature:v1\u0000${canonicalReferences}`);
}
