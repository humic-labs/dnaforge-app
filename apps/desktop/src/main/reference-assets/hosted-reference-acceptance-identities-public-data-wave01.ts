import {
  HG19_EXPECTED_ANNOTATION_TRACK_TYPES,
  MM10_EXPECTED_ANNOTATION_TRACK_TYPES,
  SUS_SCR_HXYL_V2_EXPECTED_ANNOTATION_TRACK_TYPES,
  ARS_UCD2_EXPECTED_ANNOTATION_TRACK_TYPES,
  CRI_GRI_PICRH1_EXPECTED_ANNOTATION_TRACK_TYPES,
  PAN_TRO6_EXPECTED_ANNOTATION_TRACK_TYPES,
  MEDAKA_HD_RR31_EXPECTED_ANNOTATION_TRACK_TYPES,
  GRCZ12AB_EXPECTED_ANNOTATION_TRACK_TYPES,
} from './hosted-reference-acceptance-track-rosters-public-data-wave01';

export const HG19_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'hg19',
  rawFastaRelativePath: 'hg19/hg19/92b96d16b307d824/hg19_primary.fna',
  rawFastaSha256: '92b96d16b307d824f3b6b9dc63feb237a75226f82ca2166d51ecec039bee4449',
  rawGff3RelativePath: 'hg19/hg19/a926639f2a49ae90/hg19_primary.gff3',
  rawGff3Sha256: 'a926639f2a49ae902741570244aa4fc2a1c036d266d6eac526034a077ed34f7b',
  expectedAnnotationTrackTypes: HG19_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/11/11d1b9f8579c78f8e30fc24a5fca1def3e2c83a72e2e26908f7f916cfba1f0e5',
  preparedManifestSha256: '11d1b9f8579c78f8e30fc24a5fca1def3e2c83a72e2e26908f7f916cfba1f0e5',
  firstViewTransport: Object.freeze({ kind: 'individual-objects' }),
  preparedBundleFingerprint: 'dc652a56c6094b07def0be2a91ccaae9ba764469d473b047ef5a99759df0ddde',
  firstViewRosterSha256: 'c1f55bbaa166281c9b2c468110b24c56d9da0d25b71c1304aaa3f8370ce12714',
});

export const MM10_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'mm10',
  rawFastaRelativePath: 'mm10/mm10/db16cb4633191754/mm10_primary.fna',
  rawFastaSha256: 'db16cb4633191754f1d9cc70e73d2a1f60d03fdf62bcf4902a31a4717a3d2de7',
  rawGff3RelativePath: 'mm10/mm10/c240b2d0d672ca37/mm10_primary.gff3',
  rawGff3Sha256: 'c240b2d0d672ca3775e618a5ce905bff9c8c28886383403afaded1d383b630aa',
  expectedAnnotationTrackTypes: MM10_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/8c/8ca9100e9fb7b99a0c0f2b48f33e582f05a002d5ad9b68b8dde0f68988a19856',
  preparedManifestSha256: '8ca9100e9fb7b99a0c0f2b48f33e582f05a002d5ad9b68b8dde0f68988a19856',
  firstViewTransport: Object.freeze({ kind: 'individual-objects' }),
  preparedBundleFingerprint: '20454c8dfe742901b9f3160ff7486e92597b40af28c22a3a0c1d964247099612',
  firstViewRosterSha256: '754dd7b15828450e57f5dd816c5a67f12e910045bc8afe304f937ca983e176a3',
});

export const SUS_SCR_HXYL_V2_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_054392235.1', // gitleaks:allow
  rawFastaRelativePath: 'susScrHxylV2/GCF_054392235.1/8253671f1e6d70c9/GCF_054392235.1_primary.fna',
  rawFastaSha256: '8253671f1e6d70c90528a08c7e3327bd5affbd5605ba250f2e3b0361fc4da069',
  rawGff3RelativePath: 'susScrHxylV2/GCF_054392235.1/152464f605a2db47/GCF_054392235.1_primary.gff3',
  rawGff3Sha256: '152464f605a2db47a50fcb9ab2956b0bb48b83510c5c99263bdff3d518a20d0e',
  expectedAnnotationTrackTypes: SUS_SCR_HXYL_V2_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/96/96c51a75fc3a683f0da047cc826a1d78cdc61edfadb1c7acfffe2348af704f7a',
  preparedManifestSha256: '96c51a75fc3a683f0da047cc826a1d78cdc61edfadb1c7acfffe2348af704f7a',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/17/17c5352cbbddee4fcf613d622f9aa105b9215b7a43e996f4faac34f09084dc43',
    sha256: '17c5352cbbddee4fcf613d622f9aa105b9215b7a43e996f4faac34f09084dc43',
  }),
  preparedBundleFingerprint: 'bb670db266b1c2b0f3751c228a18458137360a1d11fd97a7b6d09f0f435cac16',
  firstViewRosterSha256: 'ad503559bd38e1171d70c27f6ad591189df61bdeb359f87b6589b296e382e938',
});

export const ARS_UCD2_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_002263795.3', // gitleaks:allow
  rawFastaRelativePath: 'arsUcd2/GCF_002263795.3/74f05e56530fcc8a/GCF_002263795.3_primary.fna',
  rawFastaSha256: '74f05e56530fcc8a1c26abf4447d33f9e965356304c582cfa7a3b0d41dae3ec6',
  rawGff3RelativePath: 'arsUcd2/GCF_002263795.3/d4b72220ef4bea4e/GCF_002263795.3_primary.gff3',
  rawGff3Sha256: 'd4b72220ef4bea4e94ec5714fdbbe4888f8cd66d926e6a1f6edb51f3512699ea',
  expectedAnnotationTrackTypes: ARS_UCD2_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/dc/dccaf75016dc6571ebe458687321c01d1477fb32b00c4f91f96b46ce4abfd203',
  preparedManifestSha256: 'dccaf75016dc6571ebe458687321c01d1477fb32b00c4f91f96b46ce4abfd203',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/32/32d54eef92bfb0aac6558f818caf780b6ec2c4637efc378d0cb2ad474229f79a',
    sha256: '32d54eef92bfb0aac6558f818caf780b6ec2c4637efc378d0cb2ad474229f79a',
  }),
  preparedBundleFingerprint: 'b421563508440cf096a580c0c772b3e2c98edc7b89024bee009023e14409744d',
  firstViewRosterSha256: '4e2e492e89c836a54cc885252ab4fea47f841eb14d0579eac45748b79949b5b2',
});

export const CRI_GRI_PICRH1_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_003668045.3', // gitleaks:allow
  rawFastaRelativePath: 'criGriPicrh1/GCF_003668045.3/864aaa0bee5caa56/GCF_003668045.3_primary.fna',
  rawFastaSha256: '864aaa0bee5caa562c17d7f80d8a9178a94d7f5e3b1c7ccbb3f87a5e393c665a',
  rawGff3RelativePath: 'criGriPicrh1/GCF_003668045.3/4e003ec81bf11665/GCF_003668045.3_primary.gff3',
  rawGff3Sha256: '4e003ec81bf116653c7b72bece56e51339ba0c32dcf7199f63ecd980a2764521',
  expectedAnnotationTrackTypes: CRI_GRI_PICRH1_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/8d/8dcf1c02c8d2805451de1969d90e342b370a9981cfe201fad5ed8df21102624b',
  preparedManifestSha256: '8dcf1c02c8d2805451de1969d90e342b370a9981cfe201fad5ed8df21102624b',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/fe/fef28b1c8f2c67d1dd119b2ef940ea5be87d9e4a0c4022b793c91c84f1d1406e',
    sha256: 'fef28b1c8f2c67d1dd119b2ef940ea5be87d9e4a0c4022b793c91c84f1d1406e',
  }),
  preparedBundleFingerprint: 'b97698d61dd71bc2cdde9d7a4274057ba64b8b5bf12438c450f2baf790652bd2',
  firstViewRosterSha256: 'd26e7fe114c70d998b3337ab88b1a91ae4e9fa7b1d8dfcf597077dea7557e0e7',
});

export const PAN_TRO6_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'panTro6',
  rawFastaRelativePath: 'panTro6/panTro6/48d9311e8b3ec392/panTro6_primary.fna',
  rawFastaSha256: '48d9311e8b3ec3924e1a154f4a476a996cedd05a48182ac3db055fd6a6fd4a5f',
  rawGff3RelativePath: 'panTro6/panTro6/e43cc89d36c86e04/panTro6_primary.gff3',
  rawGff3Sha256: 'e43cc89d36c86e04698a02be1d972d19a687a12dcd34388bc47a4f4a43eb5b6a',
  expectedAnnotationTrackTypes: PAN_TRO6_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/af/af8bba7076d25773c90c32f2d222f549edfe56bd30dae1a0eeecc9b54f4efe5b',
  preparedManifestSha256: 'af8bba7076d25773c90c32f2d222f549edfe56bd30dae1a0eeecc9b54f4efe5b',
  firstViewTransport: Object.freeze({ kind: 'individual-objects' }),
  preparedBundleFingerprint: 'c6ea440d44fa55c1ad57e12dd8247758d872a9794d38759ef52b923d899a068c',
  firstViewRosterSha256: 'd5cae21f87866b3b3078667d9d26385b058a09d003382abd0d69ffd47df547e6',
});

export const MEDAKA_HD_RR31_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_053564925.1', // gitleaks:allow
  rawFastaRelativePath: 'medakaHdRr31/GCF_053564925.1/e279ec42e366550f/GCF_053564925.1_primary.fna',
  rawFastaSha256: 'e279ec42e366550fd7b96f3f5962b48a0379259b237877c0bd9a6c9a9db1cc78',
  rawGff3RelativePath: 'medakaHdRr31/GCF_053564925.1/acb28ae78e0c4dde/GCF_053564925.1_primary.gff3',
  rawGff3Sha256: 'acb28ae78e0c4dde6f7290e66316ce598a8d762714b73ef1ed5c07e8bb98d1b6',
  expectedAnnotationTrackTypes: MEDAKA_HD_RR31_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/2e/2ecebac2b49eb4ca80d3130a95b23140b3551254c57c129e614027126e905606',
  preparedManifestSha256: '2ecebac2b49eb4ca80d3130a95b23140b3551254c57c129e614027126e905606',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/56/5688055c157bac04476daf31bdbc5c0dbde47bac376e0bcb24c81c5c150accd7',
    sha256: '5688055c157bac04476daf31bdbc5c0dbde47bac376e0bcb24c81c5c150accd7',
  }),
  preparedBundleFingerprint: 'a7269ed3df6dada0a71cc93540c1bcc962699a1282a07dc7319bd5c58262ef7b',
  firstViewRosterSha256: 'c0af483aa82166251705238808113e0fa90bc89155e23efccc1ad86ad2c0f729',
});

export const GRCZ12AB_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_052040795.1', // gitleaks:allow
  rawFastaRelativePath: 'grcz12ab/GCF_052040795.1/8e3bebfc618a2cb4/GCF_052040795.1_primary.fna',
  rawFastaSha256: '8e3bebfc618a2cb4e5524eaa93c529ccf8da7903f27da5775c139812e70d8f90',
  rawGff3RelativePath: 'grcz12ab/GCF_052040795.1/619dc5f1881131a5/GCF_052040795.1_primary.gff3',
  rawGff3Sha256: '619dc5f1881131a540c31371429f62f861457f1c2b4e9c8418570dc7b9afa1fb',
  expectedAnnotationTrackTypes: GRCZ12AB_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/6f/6f888897dfa7db2a1a620a60de8343a4bbc623ab97047a9e54928c0918a6dda0',
  preparedManifestSha256: '6f888897dfa7db2a1a620a60de8343a4bbc623ab97047a9e54928c0918a6dda0',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/af/afd74348e32125fab3f5772869402612ec6a2882116800032bad0197ca7e1ee1',
    sha256: 'afd74348e32125fab3f5772869402612ec6a2882116800032bad0197ca7e1ee1',
  }),
  preparedBundleFingerprint: 'ae3d8aad5503ca09fbc28954bb2aa7ecb2917053ae679ca3d8f9f01ea91428eb',
  firstViewRosterSha256: '8dd8d82e6ce73db17a150bc873afabdce5f7a63c25a5b7a959b13c249502c950',
});
