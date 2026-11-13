import { REQUIRED_HOSTED_REFERENCE_DEMAND_CATALOG_V1 } from './hosted-reference-demand-roster';
import {
  validateHostedReferenceExternalAnnotationSourceV1,
  type HostedReferenceExternalAnnotationSourceV1,
} from './hosted-reference-external-annotation-source';

const sources = [
  {
    contract: 'dnaforge-hosted-reference-external-annotation-source.v1',
    provider: 'figshare',
    assemblyId: 'nibenKlab',
    accession: 'GCA_034376525.1', // gitleaks:allow
    articleId: 25441192,
    articleVersion: 1,
    fileId: 45147526,
    fileName: 'Nb_KLAB.gff3',
    sha256: '9b609c1d7e7937265d63efeb04ac0ca45959b581a3a8d4af1e0b27684bfda886',
    byteLength: 58_536_289,
    publishedDate: '2024-03-20',
    license: 'CC BY 4.0',
    attribution: 'Shin Ah-Young (2024)',
    sourceUrl:
      'https://figshare.com/articles/dataset/Nicotiana_benthamiana_KLAB_NbKLAB_Genome_assembly_and_annotation/25441192',
  },
] as const;

const demandById = new Map(
  REQUIRED_HOSTED_REFERENCE_DEMAND_CATALOG_V1.map((demand) => [demand.id, demand])
);
const ids = new Set<string>();
const accessions = new Set<string>();

export const HOSTED_REFERENCE_BUILD_ACQUISITION_SOURCES_V1: ReadonlyArray<HostedReferenceExternalAnnotationSourceV1> =
  Object.freeze(
    sources.map((rawSource) => {
      const source = validateHostedReferenceExternalAnnotationSourceV1(rawSource);
      if (ids.has(source.assemblyId) || accessions.has(source.accession)) {
        throw new Error('Hosted-reference acquisition sources contain a duplicate authority.');
      }
      ids.add(source.assemblyId);
      accessions.add(source.accession);
      const demand = demandById.get(source.assemblyId);
      if (
        demand?.coordinateAuthority.provider !== 'ncbi' ||
        demand.coordinateAuthority.accession !== source.accession
      ) {
        throw new Error(
          `Hosted-reference acquisition source ${source.assemblyId} does not match demand authority.`
        );
      }
      return source;
    })
  );
