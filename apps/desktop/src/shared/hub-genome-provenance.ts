export const HUB_GENOME_PROVIDER_ASSEMBLY_HUB = 'UCSC assembly hub';
export const HUB_GENOME_PROVIDER_GENARK = 'UCSC GenArk';

export interface HubGenomeTrackTargetV1 {
  readonly genomeId: string;
  readonly hubUrl: string;
}

const SAFE_GENOME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function hubGenomeTrackTargetFromProvenance(
  provenance: Readonly<{ provider: string; datasetId: string; sourceUrl?: string }>
): HubGenomeTrackTargetV1 | undefined {
  if (
    provenance.provider !== HUB_GENOME_PROVIDER_ASSEMBLY_HUB &&
    provenance.provider !== HUB_GENOME_PROVIDER_GENARK
  ) {
    return undefined;
  }
  const hubUrl = provenance.sourceUrl?.trim();
  if (!hubUrl || !/^https?:\/\/[^\s/]+/iu.test(hubUrl)) return undefined;
  if (!SAFE_GENOME_ID.test(provenance.datasetId)) return undefined;
  return { genomeId: provenance.datasetId, hubUrl };
}
