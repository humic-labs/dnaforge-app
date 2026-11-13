import {
  ECOLI_K12_MG1655_EXPECTED_ANNOTATION_TRACK_TYPES,
  ECOLI_BL21_DE3_EXPECTED_ANNOTATION_TRACK_TYPES,
  BACILLUS168_EXPECTED_ANNOTATION_TRACK_TYPES,
  PPUTIDA_KT2440_EXPECTED_ANNOTATION_TRACK_TYPES,
  CGLUTAMICUM_ATCC13032_EXPECTED_ANNOTATION_TRACK_TYPES,
  SCOELICOLOR_A32_EXPECTED_ANNOTATION_TRACK_TYPES,
  MTB_H37_RV_EXPECTED_ANNOTATION_TRACK_TYPES,
  PAERUGINOSA_PAO1_EXPECTED_ANNOTATION_TRACK_TYPES,
  SAUREUS_NCTC8325_EXPECTED_ANNOTATION_TRACK_TYPES,
  SALMONELLA_LT2_EXPECTED_ANNOTATION_TRACK_TYPES,
  SAUREUS_USA300_FPR3757_EXPECTED_ANNOTATION_TRACK_TYPES,
} from './hosted-reference-acceptance-track-rosters-public-data-bacteria';

export const ECOLI_K12_MG1655_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000005845.2', // gitleaks:allow
  rawFastaRelativePath:
    'ecoliK12Mg1655/GCF_000005845.2/53bb6a51b6e92139/GCF_000005845.2_primary.fna',
  rawFastaSha256: '53bb6a51b6e92139ced1e38f74b7938781027c52200922ff03718c2237d23bb4',
  rawGff3RelativePath:
    'ecoliK12Mg1655/GCF_000005845.2/fd4ba59c3e6232c2/GCF_000005845.2_primary.gff3',
  rawGff3Sha256: 'fd4ba59c3e6232c2c8410c120fea9c1ffce14ebf502a632f8746e8ac0b423db5',
  expectedAnnotationTrackTypes: ECOLI_K12_MG1655_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/cf/cf671985fa8a2a39fe217ccbbabeea01b670b72c9d01fe01f3f58fcb7c8878fb',
  preparedManifestSha256: 'cf671985fa8a2a39fe217ccbbabeea01b670b72c9d01fe01f3f58fcb7c8878fb',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/08/08fa19087819ba7afc29f7c30f490c39e37610a04453818fb74acdae9e6cc6b8',
    sha256: '08fa19087819ba7afc29f7c30f490c39e37610a04453818fb74acdae9e6cc6b8',
  }),
  preparedBundleFingerprint: 'fd47403b81d4a0179761060a592f1a6b94a464f095afc0f8cfa1d1d92a9d2892',
  firstViewRosterSha256: 'deecb8a86ee3bf7a652f635045c99770e7e71d29b9f94d50505d6088b774dbff',
});

export const ECOLI_BL21_DE3_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000022665.1', // gitleaks:allow
  rawFastaRelativePath: 'ecoliBl21De3/GCF_000022665.1/9225e577e41a5456/GCF_000022665.1_primary.fna',
  rawFastaSha256: '9225e577e41a54569496d542561181d963e4c16ad5a115da1b3600ab4558226f',
  rawGff3RelativePath: 'ecoliBl21De3/GCF_000022665.1/bad5e62d5349aeb3/GCF_000022665.1_primary.gff3',
  rawGff3Sha256: 'bad5e62d5349aeb3a0bffaab5a9b66c9a1cd50eee05564c130644beea2b7420b',
  expectedAnnotationTrackTypes: ECOLI_BL21_DE3_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/02/02e3e012a5a1bd226c115f31585b4ffcf5dcd0f410e90790a52dc9b3a5cb165a',
  preparedManifestSha256: '02e3e012a5a1bd226c115f31585b4ffcf5dcd0f410e90790a52dc9b3a5cb165a',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/ba/bab76ce591ebccf59fe6b8a3fda24d95125fc5102791919a2ef3078889f19165',
    sha256: 'bab76ce591ebccf59fe6b8a3fda24d95125fc5102791919a2ef3078889f19165',
  }),
  preparedBundleFingerprint: '21b2eba16782f292f84b6f4dd3c1313c5ae3fa54b0c8dc54a42ef0d9bd56d714',
  firstViewRosterSha256: 'cc6aef2489f2b5790210937767aac31989cf99d1dd15ae1e9478572eaa93b8e8',
});

export const BACILLUS168_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000009045.1', // gitleaks:allow
  rawFastaRelativePath: 'bacillus168/GCF_000009045.1/59c09816fb55fb1a/GCF_000009045.1_primary.fna',
  rawFastaSha256: '59c09816fb55fb1a0b42d0715f627bb42018a19c6bf933c9cb37f6058ee4737e',
  rawGff3RelativePath: 'bacillus168/GCF_000009045.1/583ade1198a862d3/GCF_000009045.1_primary.gff3',
  rawGff3Sha256: '583ade1198a862d3fd57c8e6a412deb86a6d50dbd25757e421990f5d9f495dea',
  expectedAnnotationTrackTypes: BACILLUS168_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/30/3022c2c0eb0290763442088017f5e441255050335abfe9989fb6d0a47a616a01',
  preparedManifestSha256: '3022c2c0eb0290763442088017f5e441255050335abfe9989fb6d0a47a616a01',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/da/dade3c85b44b86627d0a4c0e20bd6d97c1e722b55a9e51a1e00e08c8313467bf',
    sha256: 'dade3c85b44b86627d0a4c0e20bd6d97c1e722b55a9e51a1e00e08c8313467bf',
  }),
  preparedBundleFingerprint: '7c78de82486115da17fa688db66d244b6f5bef46e5549a010c66929e13699b74',
  firstViewRosterSha256: '5cf81b74e17892aa2324bb273907acac9c562728e1edadf36f360203335ef41f',
});

export const PPUTIDA_KT2440_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000007565.2', // gitleaks:allow
  rawFastaRelativePath:
    'pputidaKt2440/GCF_000007565.2/f3b9661ab008a185/GCF_000007565.2_primary.fna',
  rawFastaSha256: 'f3b9661ab008a18564e6f4e303e8c631ea77a98bb396925d49907d65f5f93e05',
  rawGff3RelativePath:
    'pputidaKt2440/GCF_000007565.2/f665c81809ada088/GCF_000007565.2_primary.gff3',
  rawGff3Sha256: 'f665c81809ada0888ed60315d30175a0a848a13d99222879f5a84b5e56efce0e',
  expectedAnnotationTrackTypes: PPUTIDA_KT2440_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/15/1574583c801344d06a5339ff575f1b87c058e0b9d5092ef393f059baac0fbe69',
  preparedManifestSha256: '1574583c801344d06a5339ff575f1b87c058e0b9d5092ef393f059baac0fbe69',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/af/affa7c9bf45d283e5090db97984b59e40a14dda88de381b85da31be9e1a34192',
    sha256: 'affa7c9bf45d283e5090db97984b59e40a14dda88de381b85da31be9e1a34192',
  }),
  preparedBundleFingerprint: 'd4b3892a35af45d7b8d67045d50fa2328764d262789277e65c38c23e09ba4dab',
  firstViewRosterSha256: 'b61493f0e0138a314302be34cb3870c6467539af1ed864900e0f7738fcdd693a',
});

export const CGLUTAMICUM_ATCC13032_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000011325.1', // gitleaks:allow
  rawFastaRelativePath:
    'cglutamicumAtcc13032/GCF_000011325.1/77a96e75167d6e75/GCF_000011325.1_primary.fna',
  rawFastaSha256: '77a96e75167d6e750d09f40616bb14a682e30b625e0f8f51fafe7c634deff636',
  rawGff3RelativePath:
    'cglutamicumAtcc13032/GCF_000011325.1/a794b57f8240d07d/GCF_000011325.1_primary.gff3',
  rawGff3Sha256: 'a794b57f8240d07d774efc9159e41c50c964ac4c0bc350ad13ce3f9c1536c485',
  expectedAnnotationTrackTypes: CGLUTAMICUM_ATCC13032_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/51/51010eb3270c319595b5408886fbb92f88830dc8b0c62b9c2721acd7e13fe42a',
  preparedManifestSha256: '51010eb3270c319595b5408886fbb92f88830dc8b0c62b9c2721acd7e13fe42a',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/27/2718a859015b36396c0de9e713433acf540667066d513ae4be5a439204569707',
    sha256: '2718a859015b36396c0de9e713433acf540667066d513ae4be5a439204569707',
  }),
  preparedBundleFingerprint: '19efac7d1679dc6e61627af03e9cd8d5fcf41ab76702ab21902a5e7398f2b9a2',
  firstViewRosterSha256: '551dcacc26151c42c73b3148684a425b039e094c040b44aea1c9c2b35a7e1f95',
});

export const SCOELICOLOR_A32_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000203835.1', // gitleaks:allow
  rawFastaRelativePath:
    'scoelicolorA32/GCF_000203835.1/0fd098e241ad998c/GCF_000203835.1_primary.fna',
  rawFastaSha256: '0fd098e241ad998c8aa090ab9f1592d6cee7d142be8a17032093bf57be123112',
  rawGff3RelativePath:
    'scoelicolorA32/GCF_000203835.1/0f6ac54bea13874a/GCF_000203835.1_primary.gff3',
  rawGff3Sha256: '0f6ac54bea13874adbe6cc44af8bf7648ff0c1d7ccd28f2cc97d99a94a9a3831',
  expectedAnnotationTrackTypes: SCOELICOLOR_A32_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/ad/ad4aa4ee86c6f29cb0ffdfa524d1f1debe11fb48b5713069d4c99be3d7e0f3fc',
  preparedManifestSha256: 'ad4aa4ee86c6f29cb0ffdfa524d1f1debe11fb48b5713069d4c99be3d7e0f3fc',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/32/321ef204f3857f0a738914cd7d95b2367a25937ec69fae6a91caba5dd048f8d3',
    sha256: '321ef204f3857f0a738914cd7d95b2367a25937ec69fae6a91caba5dd048f8d3',
  }),
  preparedBundleFingerprint: '02d487e0b3ce0997734498ae81c6eccb78b029dea670fa451c23164fed3fb09e',
  firstViewRosterSha256: '1315e1014d7ad468243963c7dda41e089c451fac8d0b90804a4cd1b75b9cf293',
});

export const MTB_H37_RV_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000195955.2', // gitleaks:allow
  rawFastaRelativePath: 'mtbH37Rv/GCF_000195955.2/427dc8cea7ffbbac/GCF_000195955.2_primary.fna',
  rawFastaSha256: '427dc8cea7ffbbac1b0baa31362bb7a30cac0a3ca9052d73634adf9122a63b28',
  rawGff3RelativePath: 'mtbH37Rv/GCF_000195955.2/56fd1dae1af5098e/GCF_000195955.2_primary.gff3',
  rawGff3Sha256: '56fd1dae1af5098e757f5e1134f7a272327d3d97161f9516e07da480ff8608f3',
  expectedAnnotationTrackTypes: MTB_H37_RV_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/c5/c57686b2fccb35a479732a0c3348f20475f1f6955e25302fb5c8f649087cbeb8',
  preparedManifestSha256: 'c57686b2fccb35a479732a0c3348f20475f1f6955e25302fb5c8f649087cbeb8',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/69/69f192bd2196b1f62585ac414b8fd54972555cafb4748667e4ea463e44c830b2',
    sha256: '69f192bd2196b1f62585ac414b8fd54972555cafb4748667e4ea463e44c830b2',
  }),
  preparedBundleFingerprint: '5f8ad8455bb3786568e4517ad8722ab2eb3c70a3e80b649644cd1c52787971c4',
  firstViewRosterSha256: '0e388431f651ec5700f475004d5810c15b4bbbc6b61a2901c295b45c89565107',
});

export const PAERUGINOSA_PAO1_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000006765.1', // gitleaks:allow
  rawFastaRelativePath:
    'paeruginosaPao1/GCF_000006765.1/3e9335fb76772d32/GCF_000006765.1_primary.fna',
  rawFastaSha256: '3e9335fb76772d324537b0c4c8cc7935e8b467b2acb0fae0c6e6dbeb2f227117',
  rawGff3RelativePath:
    'paeruginosaPao1/GCF_000006765.1/e9708fe0b89e8fa8/GCF_000006765.1_primary.gff3',
  rawGff3Sha256: 'e9708fe0b89e8fa898a86ea8ed38ed0d697e460878578917545b733fb271b170',
  expectedAnnotationTrackTypes: PAERUGINOSA_PAO1_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/8e/8e749443c68251ae9a7682139f49ca4229aacf94161266e399644d987b4bf1b6',
  preparedManifestSha256: '8e749443c68251ae9a7682139f49ca4229aacf94161266e399644d987b4bf1b6',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/d7/d71fdcd8d53719d4313ed6e0dac1adc1670dfbc1c97a31302d7d5357d7381eec',
    sha256: 'd71fdcd8d53719d4313ed6e0dac1adc1670dfbc1c97a31302d7d5357d7381eec',
  }),
  preparedBundleFingerprint: '81d3146e57e06c1d5b3ad76e05308fea1df4de2d857151bcb951166144366046',
  firstViewRosterSha256: 'ddcfe958691bc3a589d9cea98db19352f8c3a92af998cdd813a0943ae59fe443',
});

export const SAUREUS_NCTC8325_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000013425.1', // gitleaks:allow
  rawFastaRelativePath:
    'saureusNctc8325/GCF_000013425.1/05df047f78234de4/GCF_000013425.1_primary.fna',
  rawFastaSha256: '05df047f78234de456a72df5f938b7fdef98fc3af3bf8634a11d70fbd3dcd21d',
  rawGff3RelativePath:
    'saureusNctc8325/GCF_000013425.1/87aa7bfbf590a400/GCF_000013425.1_primary.gff3',
  rawGff3Sha256: '87aa7bfbf590a400c5e0cccd034051ecf46531e0efb772d1c8101505b6f61705',
  expectedAnnotationTrackTypes: SAUREUS_NCTC8325_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/b6/b600e814b08609e419e5f0ef19e9d56564c9a37457d7c82c18981a8a9ac947ae',
  preparedManifestSha256: 'b600e814b08609e419e5f0ef19e9d56564c9a37457d7c82c18981a8a9ac947ae',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/b4/b4abaf9753b96def37f605707ba408e078d9db59e4b35c60a8c6c7af88aa8f24',
    sha256: 'b4abaf9753b96def37f605707ba408e078d9db59e4b35c60a8c6c7af88aa8f24',
  }),
  preparedBundleFingerprint: '06b982afc9472ee5e29ce2fbf0808c4636092af2d5a585b4752d7d5c3609d59b',
  firstViewRosterSha256: '427dbb199e06be0515cdbba6cb0eac640b12253ff5e630ec1aef3cced04131ef',
});

export const SALMONELLA_LT2_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000006945.2', // gitleaks:allow
  rawFastaRelativePath:
    'salmonellaLt2/GCF_000006945.2/196a3eff4e6e6ed5/GCF_000006945.2_primary.fna',
  rawFastaSha256: '196a3eff4e6e6ed597173cc15d9dbde4cd55d76ad4d1b046da34cd75629c65cd',
  rawGff3RelativePath:
    'salmonellaLt2/GCF_000006945.2/54e7d835ac9f83ec/GCF_000006945.2_primary.gff3',
  rawGff3Sha256: '54e7d835ac9f83ecf7d3f8023b13aef0cfefc20721c0c5dee1eaabc991dae11e',
  expectedAnnotationTrackTypes: SALMONELLA_LT2_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/59/59f3d7c56fc1d09bf04782ffbb5f8ec4b6f29bbc62f087b65f64efe270be8bb8',
  preparedManifestSha256: '59f3d7c56fc1d09bf04782ffbb5f8ec4b6f29bbc62f087b65f64efe270be8bb8',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/97/97ab7ec8a666f7ae2ea83ab686a77da67fa9fd5f28d9c350033ce8de93f9d667',
    sha256: '97ab7ec8a666f7ae2ea83ab686a77da67fa9fd5f28d9c350033ce8de93f9d667',
  }),
  preparedBundleFingerprint: 'df74353032857ca06f0ba16e63cdcb6cd594aae555a7181eb88d352051f4bde5',
  firstViewRosterSha256: '99b80443290fef1007f1497f22b71a509dd05109cda3515074afb731df990186',
});

export const SAUREUS_USA300_FPR3757_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCA_000013465.1', // gitleaks:allow
  rawFastaRelativePath:
    'saureusUsa300Fpr3757/GCA_000013465.1/a3dc8a88d0502a32/GCA_000013465.1_primary.fna',
  rawFastaSha256: 'a3dc8a88d0502a32293e680827eb6a74b790d4c419491c1613782a06fc93a63b',
  rawGff3RelativePath:
    'saureusUsa300Fpr3757/GCA_000013465.1/82aaf72461577447/GCA_000013465.1_primary.gff3',
  rawGff3Sha256: '82aaf72461577447a5eaf6ddd1d5236bff59135d7933351b7d0c8b060332ec2a',
  expectedAnnotationTrackTypes: SAUREUS_USA300_FPR3757_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/9a/9a53f2261cec24b151cfe2eb17e710eb26a91add51925939b628211dcf9de859',
  preparedManifestSha256: '9a53f2261cec24b151cfe2eb17e710eb26a91add51925939b628211dcf9de859',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/ec/ec0fffb77fc4747c2b7fabcdce044947ca6fe3dcada9a7e00fbc9ebce1928c1d',
    sha256: 'ec0fffb77fc4747c2b7fabcdce044947ca6fe3dcada9a7e00fbc9ebce1928c1d',
  }),
  preparedBundleFingerprint: '994456a2d1f2d1594e8b524dcc1e79e373570252485a65eb128a14922aba7bd5',
  firstViewRosterSha256: '3a0d1cfb6be9f70bef5499e3bfb249c59305bda020ebde4e30a68f2e4c3726f9',
});
