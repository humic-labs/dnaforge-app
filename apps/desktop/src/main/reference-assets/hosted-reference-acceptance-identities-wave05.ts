import {
  HS1_EXPECTED_ANNOTATION_TRACK_TYPES,
  RN8_EXPECTED_ANNOTATION_TRACK_TYPES,
  RN7_EXPECTED_ANNOTATION_TRACK_TYPES,
  DAN_RER11_EXPECTED_ANNOTATION_TRACK_TYPES,
  POMBE_ASM294V3_EXPECTED_ANNOTATION_TRACK_TYPES,
  XEN_LAE10_EXPECTED_ANNOTATION_TRACK_TYPES,
  GRCG7B_EXPECTED_ANNOTATION_TRACK_TYPES,
  CAN_FAM4_EXPECTED_ANNOTATION_TRACK_TYPES,
} from './hosted-reference-acceptance-track-rosters-wave05';

export const HS1_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_009914755.1',
  rawFastaRelativePath: 'hs1/GCF_009914755.1/7794fb54c8ad99c0/GCF_009914755.1_primary.fna',
  rawFastaSha256: '7794fb54c8ad99c0ed10ad8f6b005291a901a831c879acf84c3ad203bbe97c30',
  rawGff3RelativePath: 'hs1/GCF_009914755.1/f83e8275731440fb/GCF_009914755.1_primary.gff3',
  rawGff3Sha256: 'f83e8275731440fb2a5ded656ee05ed1479fbeb0cd1632c7a1b194e15d91df81',
  expectedAnnotationTrackTypes: HS1_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/96/96da0a335e7aa0404b9d8f9b9be4391c5b869a213c84ded6ad8d547144c60baa',
  preparedManifestSha256: '96da0a335e7aa0404b9d8f9b9be4391c5b869a213c84ded6ad8d547144c60baa',
  firstViewTransport: Object.freeze({ kind: 'individual-objects' }),
  preparedBundleFingerprint: '3ca6dc2ff1e1fb6199acff9508ef74314ccc4fcbaf49c62b15590bf85b61d08a',
  firstViewRosterSha256: '89ab20e3ab87cefad3a9ab6d4f7540b84327e30975a45e5a8ab57ca4c5fc0b06',
});

export const RN8_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_036323735.1',
  rawFastaRelativePath: 'rn8/GCF_036323735.1/c63375fc868d0583/GCF_036323735.1_primary.fna',
  rawFastaSha256: 'c63375fc868d05837b892e7713cfbc83a085691b8b04b99d3ed3468ff82ead23',
  rawGff3RelativePath: 'rn8/GCF_036323735.1/1a5a4d78b04f2c1b/GCF_036323735.1_primary.gff3',
  rawGff3Sha256: '1a5a4d78b04f2c1b09153d2d217a276cd00b3602ca5a31c41c77f19dce681c86',
  expectedAnnotationTrackTypes: RN8_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/cc/cc6ae38248db298e50f9ca7fc8cf850541983b4de7bb345a4f052e3de721386f',
  preparedManifestSha256: 'cc6ae38248db298e50f9ca7fc8cf850541983b4de7bb345a4f052e3de721386f',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/8b/8bbbd9019bf5f5cad7b34fc592c88768a568e1d1301e824fa0f1ccf9cdac38c7',
    sha256: '8bbbd9019bf5f5cad7b34fc592c88768a568e1d1301e824fa0f1ccf9cdac38c7',
  }),
  preparedBundleFingerprint: 'bc29e5b1515efe758248298d54c750262c92c1ae647687af52c122a577f596f2',
  firstViewRosterSha256: 'c0a5c7b63822351cee78efb8838c43dc9d284aece79fd3c6c16305870b6be590',
});

export const RN7_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_015227675.2',
  rawFastaRelativePath: 'rn7/GCF_015227675.2/796fd1ea923076e7/GCF_015227675.2_primary.fna',
  rawFastaSha256: '796fd1ea923076e7efe3e61b30d38d956ca7ebc1047b73d7cf7cdaed9ce0db05',
  rawGff3RelativePath: 'rn7/GCF_015227675.2/3d3c36d43f8bb9ba/GCF_015227675.2_primary.gff3',
  rawGff3Sha256: '3d3c36d43f8bb9ba9870cc2217fe78be85aa167238eac3615f61b105a96eee67',
  expectedAnnotationTrackTypes: RN7_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/a6/a6f6d0472e8cce758b15ca20c18c9fa463703b229a85041fa471d05617e19179',
  preparedManifestSha256: 'a6f6d0472e8cce758b15ca20c18c9fa463703b229a85041fa471d05617e19179',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/f0/f06ba39a0664d2c31712a5258114296b674151e7415c0bb49e891fb1d731aa0f',
    sha256: 'f06ba39a0664d2c31712a5258114296b674151e7415c0bb49e891fb1d731aa0f',
  }),
  preparedBundleFingerprint: '6f9157f74ffe17864ff0348f8124a638a604cc8d239d360af1a1d4d0faae7a95',
  firstViewRosterSha256: 'd69ccdd2d3b2080917a7fe9354d394914db15ff606042b715afa9daf3a023839',
});

export const DAN_RER11_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000002035.6',
  rawFastaRelativePath: 'danRer11/GCF_000002035.6/5ef9b7d832f3e7a4/GCF_000002035.6_primary.fna',
  rawFastaSha256: '5ef9b7d832f3e7a48359f8af3d155fdd8a906573f20ff238b8ae19b647675832',
  rawGff3RelativePath: 'danRer11/GCF_000002035.6/ba7d80982543b85c/GCF_000002035.6_primary.gff3',
  rawGff3Sha256: 'ba7d80982543b85c789cf30c27730c15458af8d0361df447c9ed3e0994a51bfd',
  expectedAnnotationTrackTypes: DAN_RER11_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/db/dbf27a1a8c94ea6e19a43059229e85ce5e90f29039f8f0125112ceb21a5d20c1',
  preparedManifestSha256: 'dbf27a1a8c94ea6e19a43059229e85ce5e90f29039f8f0125112ceb21a5d20c1',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/b3/b3668115593908f867c24f9f6fcc41547712ecfe59ceb1760c3dec2231753740',
    sha256: 'b3668115593908f867c24f9f6fcc41547712ecfe59ceb1760c3dec2231753740',
  }),
  preparedBundleFingerprint: '5a9672a5f0ae054f358a99d2e443fba9ed0c40e5bed5abcdee2269b7384f4e3a',
  firstViewRosterSha256: 'a071587a0461225248278ff5d420c4a749d57e23ce654e27dff205cebb218518',
});

export const POMBE_ASM294V3_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000002945.2',
  rawFastaRelativePath:
    'pombeAsm294v3/GCF_000002945.2/fc3a90996a09d653/GCF_000002945.2_primary.fna',
  rawFastaSha256: 'fc3a90996a09d653880aea616e235c878a3224eb678f9d5f099b9d4821b29762',
  rawGff3RelativePath:
    'pombeAsm294v3/GCF_000002945.2/e2477cf9ab9a4efa/GCF_000002945.2_primary.gff3',
  rawGff3Sha256: 'e2477cf9ab9a4efa91273fa8dbbc14a4cc3971413b02b232ce18597083b131c2',
  expectedAnnotationTrackTypes: POMBE_ASM294V3_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/56/56076b15facdebd0da57edc128de38022107e425c877c48eee26f6d6c686474c',
  preparedManifestSha256: '56076b15facdebd0da57edc128de38022107e425c877c48eee26f6d6c686474c',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/03/039efe6f2476c616be9c9fa3cf7b8a873dcd57259f8546f5c95ed7bc6820dd1c',
    sha256: '039efe6f2476c616be9c9fa3cf7b8a873dcd57259f8546f5c95ed7bc6820dd1c',
  }),
  preparedBundleFingerprint: '86b691a89e16b4e1131c3093bce92fcd999f0abc3e755cc637c073fc5298f1a9',
  firstViewRosterSha256: '8eeaa141152301c7963b9c8b9c415a5b0b6cae9bd926a3bf9ca6128fa2be8de0',
});

export const XEN_LAE10_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_017654675.1',
  rawFastaRelativePath: 'xenLae10/GCF_017654675.1/25c3f611888a7d92/GCF_017654675.1_primary.fna',
  rawFastaSha256: '25c3f611888a7d923e4eb2463fd44d9d3f688b308bbe1b608873d03747d2d418',
  rawGff3RelativePath: 'xenLae10/GCF_017654675.1/6c25a5adff69e938/GCF_017654675.1_primary.gff3',
  rawGff3Sha256: '6c25a5adff69e938528a1f97663dfbfc60fba993dbe23cce82c321a2922286c7',
  expectedAnnotationTrackTypes: XEN_LAE10_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/52/523c2d479aab5096bb12149ba876f30cb8cf8a251c99e3442091f7b19b8d421e',
  preparedManifestSha256: '523c2d479aab5096bb12149ba876f30cb8cf8a251c99e3442091f7b19b8d421e',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/95/952c6f708143879faffc56f416a157ae5f2902caba7ea4a07538848502c385d9',
    sha256: '952c6f708143879faffc56f416a157ae5f2902caba7ea4a07538848502c385d9',
  }),
  preparedBundleFingerprint: '09fbe46e74570d54a70d2883fecc91bf38f0092db7b5d878faee92bd35d00d56',
  firstViewRosterSha256: '1c57a09bab670c8bbade45318013db75c4967b308822faaf1644abecac3cf89e',
});

export const GRCG7B_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_016699485.2', // gitleaks:allow
  rawFastaRelativePath: 'grcg7b/GCF_016699485.2/2bf52b837fc6b8c2/GCF_016699485.2_primary.fna',
  rawFastaSha256: '2bf52b837fc6b8c2e06f8233295d34483729fbf42698a351d263ac151b1dca4a',
  rawGff3RelativePath: 'grcg7b/GCF_016699485.2/251b9d3944e8e157/GCF_016699485.2_primary.gff3',
  rawGff3Sha256: '251b9d3944e8e15743cd95f6d9a22afda6a4d25ae46a7516da174c2b2f918899',
  expectedAnnotationTrackTypes: GRCG7B_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/26/260a1c6b1c9f44b5bcd82befbb6ee732c8c2f2f3608e17bddd57b548830f8a36',
  preparedManifestSha256: '260a1c6b1c9f44b5bcd82befbb6ee732c8c2f2f3608e17bddd57b548830f8a36',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/da/daf2af58fce98239e2b2b6dd1d918328f9c63f5939a933e986fea162b43ed9db',
    sha256: 'daf2af58fce98239e2b2b6dd1d918328f9c63f5939a933e986fea162b43ed9db',
  }),
  preparedBundleFingerprint: '3f5d791a392660eb9f6fe19f90e183e594aef3f2cac0d0a31aa526784b44ce77',
  firstViewRosterSha256: '218dca189c00370420dc97a1e41879159f69a37dbef5cb5eb044ac19772c7a96',
});

export const CAN_FAM4_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_011100685.1',
  rawFastaRelativePath: 'canFam4/GCF_011100685.1/9cffd31c9b254efe/GCF_011100685.1_primary.fna',
  rawFastaSha256: '9cffd31c9b254efefd76e91baf6d3176e58cbeb72075efb3b5e641fce9b5256b',
  rawGff3RelativePath: 'canFam4/GCF_011100685.1/dd449f3e2507cdfc/GCF_011100685.1_primary.gff3',
  rawGff3Sha256: 'dd449f3e2507cdfcff10868b7991cc487b06f06a0256b5a3dce71049be7b15bd',
  expectedAnnotationTrackTypes: CAN_FAM4_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/4e/4eedc0673376c672e34235bfa189939a0adb9aa4f1e6de48c74df0b72f4ab529',
  preparedManifestSha256: '4eedc0673376c672e34235bfa189939a0adb9aa4f1e6de48c74df0b72f4ab529',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/ab/abb194df0865c61bbccf4205f5d120d262a3810d5ce6c76ce18ab0b2bd71d1eb',
    sha256: 'abb194df0865c61bbccf4205f5d120d262a3810d5ce6c76ce18ab0b2bd71d1eb',
  }),
  preparedBundleFingerprint: '019b357f875ff2d43468760a4de6ef540a54483d2bf9af1c57c54e5eb52753b0',
  firstViewRosterSha256: 'e8aa1bf616a0fc91cdd613ce13dfa1f96142b7cfc07b494167bc7fac6dd4e85a',
});
