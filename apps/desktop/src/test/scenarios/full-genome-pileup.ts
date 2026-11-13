import type { AppScenario } from './types';

declare const __DEV_WP_ASSETS_PATH__: string;
const WP_ASSETS = __DEV_WP_ASSETS_PATH__ || import.meta.env.VITE_WP_ASSETS_PATH || '';

function wpAssetsPath(relativePath: string): string {
  const root = WP_ASSETS.replace(/[\\/]+$/, '');
  return root ? `${root}/${relativePath}` : relativePath;
}

const REMOTE_HG002_80X_BAM =
  'https://ftp-trace.ncbi.nlm.nih.gov/ReferenceSamples/giab/data/AshkenazimTrio/HG002_NA24385_son/Element_AVITI_20240920/HG002_Element-StdInsert_80x_GRCh38-GIABv3.bam';
const LOCAL_NA12718_CRAM = wpAssetsPath('bam-cache/NA12718.final.cram');
const LOCAL_NA12718_CRAI = wpAssetsPath('bam-cache/NA12718.final.cram.crai');
const LOCAL_GRCH38_REF = wpAssetsPath('reference/GRCh38_full_analysis_set_plus_decoy_hla.fa');
const LOCAL_HG002_80X_BAM = wpAssetsPath('bam-cache/HG002_Element_80x_GRCh38.bam');
const LOCAL_HG002_80X_BAI = wpAssetsPath('bam-cache/HG002_Element_80x_GRCh38.bam.bai');
const LOCAL_HG002_GRCH38_VCF = wpAssetsPath(
  'variant-cache/HG002_GRCh38_1_22_v4.2.1_benchmark.vcf.gz'
);

function fullGenomePileup(
  source: {
    bamPath: string;
    indexPath?: string;
    referencePath?: string;
  },
  label: string
): AppScenario {
  return {
    laneContract: {
      assemblyId: 'grch38',
      activeDataset: {
        kind: 'pileup',
        trackType: 'pileup-genomewide',
        trackId: 'pileup-genomewide-grch38',
        label,
        color: 0xa8ceff,
        laneHeightPx: 3,
        maxLanes: 80,
        overflowBandHeightPx: 36,
        trackPx: 80 * 3 + 36,
        records: [],
        source,
      },
    },
  };
}

export function grch38GenomeWidePileup(): AppScenario {
  return fullGenomePileup(
    { bamPath: REMOTE_HG002_80X_BAM },
    'GRCh38 WGS pileup (HG002 Element 80x, remote, all chromosomes)'
  );
}

export function grch38GenomeWideLocalNA12718Cram(): AppScenario {
  return fullGenomePileup(
    {
      bamPath: LOCAL_NA12718_CRAM,
      indexPath: LOCAL_NA12718_CRAI,
      referencePath: LOCAL_GRCH38_REF,
    },
    'GRCh38 WGS pileup (NA12718 30× CRAM, LOCAL, all chromosomes)'
  );
}

export function grch38GenomeWideLocalHg002_80x(): AppScenario {
  return fullGenomePileup(
    { bamPath: LOCAL_HG002_80X_BAM, indexPath: LOCAL_HG002_80X_BAI },
    'GRCh38 WGS pileup (HG002 80× BAM, LOCAL, all chromosomes)'
  );
}

export function grch38GenomeWideLocalHg002_80xMutations(): AppScenario {
  return {
    ...grch38GenomeWideLocalHg002_80x(),
    variantSource: {
      path: LOCAL_HG002_GRCH38_VCF,
    },
  };
}
