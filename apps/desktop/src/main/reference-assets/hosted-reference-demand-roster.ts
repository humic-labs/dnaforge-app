export type HostedReferenceDemandCohortV1 = 'core' | 'comparative' | 'plants' | 'microbes';

export type NcbiAssemblyAccessionV1 = `GC${'F' | 'A'}_${string}.${number}`;

export type HostedReferenceCoordinateAuthorityV1 =
  | Readonly<{
      provider: 'ncbi';
      accession: NcbiAssemblyAccessionV1;
    }>
  | Readonly<{
      provider: 'ucsc';
      genomeId: string;
    }>;

export interface HostedReferenceDemandV1 {
  readonly id: string;
  readonly cohort: HostedReferenceDemandCohortV1;
  readonly role: string;
  readonly name: string;
  readonly organism: string;
  readonly assembly: string;
  readonly coordinateAuthority: HostedReferenceCoordinateAuthorityV1;
  readonly igvGenomeId?: string;
}

function coordinateAuthorityKey(authority: HostedReferenceCoordinateAuthorityV1): string {
  return authority.provider === 'ncbi'
    ? `ncbi:${authority.accession}`
    : `ucsc:${authority.genomeId}`;
}

export function createHostedReferenceDemandRosterV1(
  demands: readonly HostedReferenceDemandV1[]
): readonly HostedReferenceDemandV1[] {
  const ids = new Set<string>();
  const coordinateAuthorities = new Set<string>();
  const igvGenomeIds = new Set<string>();

  for (const demand of demands) {
    if (ids.has(demand.id)) {
      throw new Error(`Required hosted-reference demand ID is duplicated: ${demand.id}`);
    }
    ids.add(demand.id);

    const authorityKey = coordinateAuthorityKey(demand.coordinateAuthority);
    if (coordinateAuthorities.has(authorityKey)) {
      throw new Error(
        `Required hosted-reference coordinate authority is duplicated: ${authorityKey}`
      );
    }
    coordinateAuthorities.add(authorityKey);

    if (!demand.igvGenomeId) continue;
    if (igvGenomeIds.has(demand.igvGenomeId)) {
      throw new Error(`Required IGV genome ID is duplicated: ${demand.igvGenomeId}`);
    }
    igvGenomeIds.add(demand.igvGenomeId);
  }

  return Object.freeze(
    demands.map((demand) =>
      Object.freeze({
        ...demand,
        coordinateAuthority: Object.freeze({ ...demand.coordinateAuthority }),
      })
    )
  );
}

function ncbi(accession: NcbiAssemblyAccessionV1): HostedReferenceCoordinateAuthorityV1 {
  return { provider: 'ncbi', accession };
}

function ucsc(genomeId: string): HostedReferenceCoordinateAuthorityV1 {
  return { provider: 'ucsc', genomeId };
}

export const REQUIRED_HOSTED_REFERENCE_DEMAND_CATALOG_V1 = createHostedReferenceDemandRosterV1([
  {
    id: 'grch38',
    cohort: 'core',
    role: 'human',
    name: 'GRCh38.p14 (human)',
    organism: 'Homo sapiens',
    assembly: 'GRCh38.p14',
    coordinateAuthority: ncbi('GCF_000001405.40'),
    igvGenomeId: 'hg38',
  },
  {
    id: 'hs1',
    cohort: 'core',
    role: 'human',
    name: 'T2T CHM13 v2.0 (human)',
    organism: 'Homo sapiens',
    assembly: 'T2T-CHM13v2.0',
    coordinateAuthority: ncbi('GCF_009914755.1'),
    igvGenomeId: 'hs1',
  },
  {
    id: 'hg19',
    cohort: 'core',
    role: 'human',
    name: 'GRCh37 (human)',
    organism: 'Homo sapiens',
    assembly: 'GRCh37 / hg19',
    coordinateAuthority: ucsc('hg19'),
    igvGenomeId: 'hg19',
  },
  {
    id: 'mm39',
    cohort: 'core',
    role: 'mouse',
    name: 'GRCm39 (mouse)',
    organism: 'Mus musculus',
    assembly: 'GRCm39',
    coordinateAuthority: ncbi('GCF_000001635.27'),
    igvGenomeId: 'mm39',
  },
  {
    id: 'mm10',
    cohort: 'core',
    role: 'mouse',
    name: 'GRCm38 (mouse)',
    organism: 'Mus musculus',
    assembly: 'GRCm38 / mm10',
    coordinateAuthority: ucsc('mm10'),
    igvGenomeId: 'mm10',
  },
  {
    id: 'rn8',
    cohort: 'core',
    role: 'rat',
    name: 'GRCr8 (rat)',
    organism: 'Rattus norvegicus',
    assembly: 'GRCr8',
    coordinateAuthority: ncbi('GCF_036323735.1'),
  },
  {
    id: 'rn7',
    cohort: 'core',
    role: 'rat',
    name: 'mRatBN7.2 (rat)',
    organism: 'Rattus norvegicus',
    assembly: 'mRatBN7.2',
    coordinateAuthority: ncbi('GCF_015227675.2'),
    igvGenomeId: 'rn7',
  },
  {
    id: 'grcz12tu',
    cohort: 'core',
    role: 'zebrafish',
    name: 'GRCz12tu (zebrafish)',
    organism: 'Danio rerio',
    assembly: 'GRCz12tu',
    coordinateAuthority: ncbi('GCF_049306965.2'),
  },
  {
    id: 'danRer11',
    cohort: 'core',
    role: 'zebrafish',
    name: 'GRCz11 (zebrafish)',
    organism: 'Danio rerio',
    assembly: 'GRCz11',
    coordinateAuthority: ncbi('GCF_000002035.6'),
    igvGenomeId: 'danRer11',
  },
  {
    id: 'dm6',
    cohort: 'core',
    role: 'fruit-fly',
    name: 'D. melanogaster (dm6)',
    organism: 'Drosophila melanogaster',
    assembly: 'Release 6 plus ISO1 MT',
    coordinateAuthority: ncbi('GCF_000001215.4'),
    igvGenomeId: 'dm6',
  },
  {
    id: 'ce11',
    cohort: 'core',
    role: 'nematode',
    name: 'C. elegans (ce11 / WBcel235)',
    organism: 'Caenorhabditis elegans',
    assembly: 'WBcel235',
    coordinateAuthority: ncbi('GCF_000002985.6'),
    igvGenomeId: 'ce11',
  },
  {
    id: 'sacCer3',
    cohort: 'core',
    role: 'budding-yeast',
    name: 'S. cerevisiae (sacCer3)',
    organism: 'Saccharomyces cerevisiae S288C',
    assembly: 'R64',
    coordinateAuthority: ncbi('GCF_000146045.2'),
    igvGenomeId: 'sacCer3',
  },
  {
    id: 'pombeAsm294v3',
    cohort: 'core',
    role: 'fission-yeast',
    name: 'S. pombe (ASM294v3)',
    organism: 'Schizosaccharomyces pombe',
    assembly: 'ASM294v3',
    coordinateAuthority: ncbi('GCF_000002945.2'),
  },
  {
    id: 'xenTro10',
    cohort: 'core',
    role: 'xenopus',
    name: 'X. tropicalis (xenTro10)',
    organism: 'Xenopus tropicalis',
    assembly: 'UCB_Xtro_10.0',
    coordinateAuthority: ncbi('GCF_000004195.4'),
  },
  {
    id: 'xenLae10',
    cohort: 'core',
    role: 'xenopus',
    name: 'X. laevis v10.1',
    organism: 'Xenopus laevis',
    assembly: 'Xenopus_laevis_v10.1',
    coordinateAuthority: ncbi('GCF_017654675.1'),
  },
  {
    id: 'grcg7b',
    cohort: 'core',
    role: 'chicken',
    name: 'GRCg7b (chicken)',
    organism: 'Gallus gallus',
    assembly: 'bGalGal1.mat.broiler.GRCg7b',
    coordinateAuthority: ncbi('GCF_016699485.2'),
    igvGenomeId: 'GCF_016699485.2',
  },
  {
    id: 'canFam4',
    cohort: 'core',
    role: 'dog',
    name: 'UU_Cfam_GSD_1.0 (dog)',
    organism: 'Canis lupus familiaris',
    assembly: 'UU_Cfam_GSD_1.0',
    coordinateAuthority: ncbi('GCF_011100685.1'),
    igvGenomeId: 'canFam4',
  },
  {
    id: 'susScrHxylV2',
    cohort: 'core',
    role: 'pig',
    name: 'HxYL maternal Yorkshire Landrace v2.0 (pig)',
    organism: 'Sus scrofa',
    assembly: 'Sscrofa_HxYL_maternal_Yorkshire_Landrace_v2.0',
    coordinateAuthority: ncbi('GCF_054392235.1'),
  },
  {
    id: 'arsUcd2',
    cohort: 'core',
    role: 'cow',
    name: 'ARS-UCD2.0 (cow)',
    organism: 'Bos taurus',
    assembly: 'ARS-UCD2.0',
    coordinateAuthority: ncbi('GCF_002263795.3'),
  },
  {
    id: 'criGriPicrh1',
    cohort: 'core',
    role: 'chinese-hamster',
    name: 'CriGri-PICRH-1.0 (Chinese hamster)',
    organism: 'Cricetulus griseus',
    assembly: 'CriGri-PICRH-1.0',
    coordinateAuthority: ncbi('GCF_003668045.3'),
  },
  {
    id: 't2tMmu8v2',
    cohort: 'comparative',
    role: 'rhesus-macaque',
    name: 'T2T-MMU8v2.0 (rhesus macaque)',
    organism: 'Macaca mulatta',
    assembly: 'T2T-MMU8v2.0',
    coordinateAuthority: ncbi('GCF_049350105.2'),
  },
  {
    id: 't2tMfa8v11',
    cohort: 'comparative',
    role: 'cynomolgus-macaque',
    name: 'T2T-MFA8 v1.1 (cynomolgus macaque)',
    organism: 'Macaca fascicularis',
    assembly: 'T2T-MFA8v1.1',
    coordinateAuthority: ncbi('GCF_037993035.2'),
  },
  {
    id: 'rheMac10',
    cohort: 'comparative',
    role: 'rhesus-macaque',
    name: 'Mmul_10 (rhesus macaque)',
    organism: 'Macaca mulatta',
    assembly: 'Mmul_10',
    coordinateAuthority: ncbi('GCF_003339765.1'),
  },
  {
    id: 'mPanTro3v21',
    cohort: 'comparative',
    role: 'chimpanzee',
    name: 'NHGRI mPanTro3 v2.1 (chimpanzee)',
    organism: 'Pan troglodytes',
    assembly: 'NHGRI_mPanTro3-v2.1_pri',
    coordinateAuthority: ncbi('GCF_028858775.2'),
  },
  {
    id: 'panTro6',
    cohort: 'comparative',
    role: 'chimpanzee',
    name: 'Clint PTR v2 (chimpanzee)',
    organism: 'Pan troglodytes',
    assembly: 'Clint_PTRv2 / panTro6',
    coordinateAuthority: ucsc('panTro6'),
    igvGenomeId: 'panTro6',
  },
  {
    id: 'mGorGor1v21',
    cohort: 'comparative',
    role: 'gorilla',
    name: 'NHGRI mGorGor1 v2.1 (gorilla)',
    organism: 'Gorilla gorilla gorilla',
    assembly: 'NHGRI_mGorGor1-v2.1_pri',
    coordinateAuthority: ncbi('GCF_029281585.2'),
  },
  {
    id: 'mOryCun11',
    cohort: 'comparative',
    role: 'rabbit',
    name: 'mOryCun1.1 (rabbit)',
    organism: 'Oryctolagus cuniculus',
    assembly: 'mOryCun1.1',
    coordinateAuthority: ncbi('GCF_964237555.1'),
  },
  {
    id: 'oarRambouilletV3',
    cohort: 'comparative',
    role: 'sheep',
    name: 'ARS-UI Rambouillet v3.0 (sheep)',
    organism: 'Ovis aries',
    assembly: 'ARS-UI_Ramb_v3.0',
    coordinateAuthority: ncbi('GCF_016772045.2'),
  },
  {
    id: 'equCabTbT2t',
    cohort: 'comparative',
    role: 'horse',
    name: 'TB-T2T (horse)',
    organism: 'Equus caballus',
    assembly: 'TB-T2T',
    coordinateAuthority: ncbi('GCF_041296265.1'),
  },
  {
    id: 'medakaHdRr31',
    cohort: 'comparative',
    role: 'medaka',
    name: 'Hd-rR 3.1 (medaka)',
    organism: 'Oryzias latipes',
    assembly: 'Olatipes_Hd-rR_3.1',
    coordinateAuthority: ncbi('GCF_053564925.1'),
  },
  {
    id: 'grcz12ab',
    cohort: 'comparative',
    role: 'zebrafish',
    name: 'GRCz12ab (zebrafish)',
    organism: 'Danio rerio',
    assembly: 'GRCz12ab',
    coordinateAuthority: ncbi('GCF_052040795.1'),
  },
  {
    id: 'galGal6',
    cohort: 'comparative',
    role: 'chicken',
    name: 'GRCg6a (chicken)',
    organism: 'Gallus gallus',
    assembly: 'GRCg6a',
    coordinateAuthority: ncbi('GCF_000002315.5'),
    igvGenomeId: 'galGal6',
  },
  {
    id: 'canFam6',
    cohort: 'comparative',
    role: 'dog',
    name: 'Dog10K Boxer Tasha (dog)',
    organism: 'Canis lupus familiaris',
    assembly: 'Dog10K_Boxer_Tasha',
    coordinateAuthority: ncbi('GCF_000002285.5'),
    igvGenomeId: 'canFam6',
  },
  {
    id: 'canFam3',
    cohort: 'comparative',
    role: 'dog',
    name: 'CanFam3.1 (dog)',
    organism: 'Canis lupus familiaris',
    assembly: 'CanFam3.1',
    coordinateAuthority: ncbi('GCF_000002285.3'),
    igvGenomeId: 'canFam3',
  },
  {
    id: 'susScr11',
    cohort: 'comparative',
    role: 'pig',
    name: 'Sscrofa11.1 (pig)',
    organism: 'Sus scrofa',
    assembly: 'Sscrofa11.1',
    coordinateAuthority: ncbi('GCF_000003025.6'),
    igvGenomeId: 'susScr11',
  },
  {
    id: 'bosTau9',
    cohort: 'comparative',
    role: 'cow',
    name: 'ARS-UCD1.2 (cow)',
    organism: 'Bos taurus',
    assembly: 'ARS-UCD1.2',
    coordinateAuthority: ncbi('GCF_002263795.1'),
    igvGenomeId: 'bosTau9',
  },
  {
    id: 'pomBase',
    cohort: 'comparative',
    role: 'fission-yeast',
    name: 'S. pombe (ASM294v2)',
    organism: 'Schizosaccharomyces pombe',
    assembly: 'ASM294v2',
    coordinateAuthority: ncbi('GCF_000002945.1'),
  },
  {
    id: 'smedA2h1',
    cohort: 'comparative',
    role: 'planaria',
    name: 'S. mediterranea (schMedA2h1)',
    organism: 'Schmidtea mediterranea',
    assembly: 'schMedA2h1',
    coordinateAuthority: ncbi('GCA_057920485.1'),
  },
  {
    id: 'tair10',
    cohort: 'plants',
    role: 'arabidopsis',
    name: 'A. thaliana (TAIR10.1)',
    organism: 'Arabidopsis thaliana',
    assembly: 'TAIR10.1',
    coordinateAuthority: ncbi('GCF_000001735.4'),
    igvGenomeId: 'tair10',
  },
  {
    id: 'agis1',
    cohort: 'plants',
    role: 'rice',
    name: 'O. sativa (AGIS1.0)',
    organism: 'Oryza sativa Japonica Group',
    assembly: 'AGIS1.0',
    coordinateAuthority: ncbi('GCF_034140825.1'),
  },
  {
    id: 'irgsp1',
    cohort: 'plants',
    role: 'rice',
    name: 'O. sativa (IRGSP-1.0)',
    organism: 'Oryza sativa Japonica Group',
    assembly: 'IRGSP-1.0',
    coordinateAuthority: ncbi('GCF_001433935.1'),
    igvGenomeId: 'GCF_001433935.1',
  },
  {
    id: 'zmB73v5',
    cohort: 'plants',
    role: 'maize',
    name: 'Z. mays B73 (NAM-5.0)',
    organism: 'Zea mays',
    assembly: 'Zm-B73-REFERENCE-NAM-5.0',
    coordinateAuthority: ncbi('GCF_902167145.1'),
  },
  {
    id: 'sbicolorNcbiv3',
    cohort: 'plants',
    role: 'sorghum',
    name: 'S. bicolor (NCBIv3)',
    organism: 'Sorghum bicolor',
    assembly: 'Sorghum_bicolor_NCBIv3',
    coordinateAuthority: ncbi('GCF_000003195.3'),
  },
  {
    id: 'ntK326',
    cohort: 'plants',
    role: 'tobacco',
    name: 'N. tabacum (ASM71507v2)',
    organism: 'Nicotiana tabacum',
    assembly: 'ASM71507v2',
    coordinateAuthority: ncbi('GCF_000715075.1'),
  },
  {
    id: 'nibenKlab',
    cohort: 'plants',
    role: 'benthamiana',
    name: 'N. benthamiana (NbKLAB)',
    organism: 'Nicotiana benthamiana',
    assembly: 'ASM3437652v1',
    coordinateAuthority: ncbi('GCA_034376525.1'),
  },
  {
    id: 'spirodelaPolyrhiza',
    cohort: 'plants',
    role: 'duckweed',
    name: 'S. polyrhiza (ASM6066549v1)',
    organism: 'Spirodela polyrhiza',
    assembly: 'ASM6066549v1',
    coordinateAuthority: ncbi('GCA_060665495.1'),
  },
  {
    id: 'tomatoSlmR21',
    cohort: 'plants',
    role: 'tomato',
    name: 'S. lycopersicum (SLM r2.1)',
    organism: 'Solanum lycopersicum',
    assembly: 'SLM_r2.1',
    coordinateAuthority: ncbi('GCF_036512215.1'),
  },
  {
    id: 'soybeanV4',
    cohort: 'plants',
    role: 'soybean',
    name: 'G. max v4.0 (soybean)',
    organism: 'Glycine max',
    assembly: 'Glycine_max_v4.0',
    coordinateAuthority: ncbi('GCF_000004515.6'),
  },
  {
    id: 'wheatRefseqV21',
    cohort: 'plants',
    role: 'wheat',
    name: 'Chinese Spring RefSeq v2.1 (wheat)',
    organism: 'Triticum aestivum',
    assembly: 'IWGSC CS RefSeq v2.1',
    coordinateAuthority: ncbi('GCF_018294505.1'),
  },
  {
    id: 'ecoliK12Mg1655',
    cohort: 'microbes',
    role: 'e-coli',
    name: 'E. coli K-12 MG1655',
    organism: 'Escherichia coli str. K-12 substr. MG1655',
    assembly: 'ASM584v2',
    coordinateAuthority: ncbi('GCF_000005845.2'),
  },
  {
    id: 'ecoliBl21De3',
    cohort: 'microbes',
    role: 'e-coli',
    name: 'E. coli BL21(DE3)',
    organism: 'Escherichia coli BL21(DE3)',
    assembly: 'ASM2266v1',
    coordinateAuthority: ncbi('GCF_000022665.1'),
  },
  {
    id: 'bacillus168',
    cohort: 'microbes',
    role: 'bacillus',
    name: 'B. subtilis 168',
    organism: 'Bacillus subtilis subsp. subtilis str. 168',
    assembly: 'ASM904v1',
    coordinateAuthority: ncbi('GCF_000009045.1'),
  },
  {
    id: 'pputidaKt2440',
    cohort: 'microbes',
    role: 'pseudomonas',
    name: 'P. putida KT2440',
    organism: 'Pseudomonas putida KT2440',
    assembly: 'ASM756v2',
    coordinateAuthority: ncbi('GCF_000007565.2'),
  },
  {
    id: 'cglutamicumAtcc13032',
    cohort: 'microbes',
    role: 'corynebacterium',
    name: 'C. glutamicum ATCC 13032',
    organism: 'Corynebacterium glutamicum ATCC 13032',
    assembly: 'ASM1132v1',
    coordinateAuthority: ncbi('GCF_000011325.1'),
  },
  {
    id: 'scoelicolorA32',
    cohort: 'microbes',
    role: 'streptomyces',
    name: 'S. coelicolor A3(2)',
    organism: 'Streptomyces coelicolor A3(2)',
    assembly: 'ASM20383v1',
    coordinateAuthority: ncbi('GCF_000203835.1'),
  },
  {
    id: 'kphaffiiGs115',
    cohort: 'microbes',
    role: 'komagataella',
    name: 'K. phaffii GS115',
    organism: 'Komagataella phaffii GS115',
    assembly: 'ASM2700v1',
    coordinateAuthority: ncbi('GCF_000027005.1'),
  },
  {
    id: 'kphaffiiCbs7435',
    cohort: 'microbes',
    role: 'komagataella',
    name: 'K. phaffii CBS 7435',
    organism: 'Komagataella phaffii CBS 7435',
    assembly: 'PicPas_Mar2011',
    coordinateAuthority: ncbi('GCA_000223565.1'),
  },
  {
    id: 'candidaSC5314',
    cohort: 'microbes',
    role: 'candida',
    name: 'C. albicans SC5314',
    organism: 'Candida albicans SC5314',
    assembly: 'ASM18296v3',
    coordinateAuthority: ncbi('GCF_000182965.3'),
  },
  {
    id: 'anidulansFgscA4',
    cohort: 'microbes',
    role: 'aspergillus',
    name: 'A. nidulans FGSC A4',
    organism: 'Aspergillus nidulans FGSC A4',
    assembly: 'ASM1142v1',
    coordinateAuthority: ncbi('GCF_000011425.1'),
  },
  {
    id: 'mtbH37Rv',
    cohort: 'microbes',
    role: 'mycobacterium',
    name: 'M. tuberculosis H37Rv',
    organism: 'Mycobacterium tuberculosis H37Rv',
    assembly: 'ASM19595v2',
    coordinateAuthority: ncbi('GCF_000195955.2'),
  },
  {
    id: 'paeruginosaPao1',
    cohort: 'microbes',
    role: 'pseudomonas',
    name: 'P. aeruginosa PAO1',
    organism: 'Pseudomonas aeruginosa PAO1',
    assembly: 'ASM676v1',
    coordinateAuthority: ncbi('GCF_000006765.1'),
  },
  {
    id: 'saureusNctc8325',
    cohort: 'microbes',
    role: 'staphylococcus',
    name: 'S. aureus NCTC 8325',
    organism: 'Staphylococcus aureus subsp. aureus NCTC 8325',
    assembly: 'ASM1342v1',
    coordinateAuthority: ncbi('GCF_000013425.1'),
  },
  {
    id: 'saureusUsa300Fpr3757',
    cohort: 'microbes',
    role: 'staphylococcus',
    name: 'S. aureus USA300 FPR3757',
    organism: 'Staphylococcus aureus subsp. aureus USA300_FPR3757',
    assembly: 'ASM1346v1',
    coordinateAuthority: ncbi('GCA_000013465.1'),
  },
  {
    id: 'salmonellaLt2',
    cohort: 'microbes',
    role: 'salmonella',
    name: 'S. Typhimurium LT2',
    organism: 'Salmonella enterica serovar Typhimurium LT2',
    assembly: 'ASM694v2',
    coordinateAuthority: ncbi('GCF_000006945.2'),
  },
  {
    id: 'sarsCov2WuhanHu1',
    cohort: 'microbes',
    role: 'virus',
    name: 'SARS-CoV-2 Wuhan-Hu-1',
    organism: 'Severe acute respiratory syndrome coronavirus 2',
    assembly: 'ASM985889v3',
    coordinateAuthority: ncbi('GCF_009858895.2'),
    igvGenomeId: 'ASM985889v3',
  },
  {
    id: 'pfalciparum3d7',
    cohort: 'microbes',
    role: 'plasmodium',
    name: 'P. falciparum 3D7',
    organism: 'Plasmodium falciparum 3D7',
    assembly: 'GCA_000002765',
    coordinateAuthority: ncbi('GCF_000002765.6'),
  },
  {
    id: 'agambiaeF1',
    cohort: 'microbes',
    role: 'mosquito',
    name: 'A. gambiae F1',
    organism: 'Anopheles gambiae',
    assembly: 'idAnoGambNW_F1_1',
    coordinateAuthority: ncbi('GCF_943734735.2'),
  },
]);
