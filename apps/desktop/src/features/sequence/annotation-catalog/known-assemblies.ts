import {
  assemblyAccession,
  sourceId,
  type AnnotationSourceDefinition,
  type AssemblyIdentity,
} from '@waypoint/genome-data/annotation-catalog';

export interface KnownAssembly {
  readonly assembly: AssemblyIdentity;
  readonly displayName: string;
  readonly identifiers: readonly string[];
  readonly unavailableSources: readonly AnnotationSourceDefinition[];
}

export const ECOLI_K12_MG1655_ASSEMBLY: AssemblyIdentity = Object.freeze({
  accession: assemblyAccession('NC_000913.3'),
  lengthBp: 4_641_652,
});

export const ECOLI_K12_MG1655_DISPLAY_NAME = 'E. coli K-12 MG1655';

const ECOCYC_UNAVAILABLE_REASON =
  'EcoCyc is redistributable only under SRI International\'s terms of use: using its data or web services accepts those terms, and shipping it requires notifying SRI, linking to biocyc.org, and showing "Includes BioCyc pathway/genome databases under license from SRI International" with the BioCyc logo on the product and its marketing. Not accepted for this prototype.';

const ECOCYC_UNAVAILABLE: AnnotationSourceDefinition = {
  id: sourceId('ecocyc-open-database'),
  label: 'EcoCyc',
  kinds: ['promoter', 'terminator', 'transcription_unit'],
  assembly: ECOLI_K12_MG1655_ASSEMBLY.accession,
  evidence: 'curated',
  derivedFrom: [],
  availability: { status: 'unavailable', reason: ECOCYC_UNAVAILABLE_REASON },
  provenance: {
    citation: 'EcoCyc, SRI International.',
    url: 'https://ecocyc.org',
    doi: null,
    datasetVersion: 'Not loaded',
    liftedFrom: null,
    license: {
      spdx: 'LicenseRef-SRI-BioCyc-Open-Database',
      attribution: 'EcoCyc data are not included in DNAForge.',
      evidenceUrl: 'https://bioinformatics.ai.sri.com/ptools/licensing/all-reg.shtml',
    },
  },
  load: () => Promise.reject(new Error(`EcoCyc is unavailable: ${ECOCYC_UNAVAILABLE_REASON}`)),
};

export const KNOWN_ASSEMBLIES: readonly KnownAssembly[] = Object.freeze([
  {
    assembly: ECOLI_K12_MG1655_ASSEMBLY,
    displayName: ECOLI_K12_MG1655_DISPLAY_NAME,
    identifiers: ['NC_000913.3', 'U00096.3', 'NC_000913', 'U00096'],
    unavailableSources: [ECOCYC_UNAVAILABLE],
  },
]);

export function knownAssembly(accession: string): KnownAssembly | undefined {
  return KNOWN_ASSEMBLIES.find((known) => known.assembly.accession === accession);
}
