import {
  IRGSP1_EXPECTED_ANNOTATION_TRACK_TYPES,
  SOYBEAN_V4_EXPECTED_ANNOTATION_TRACK_TYPES,
  NT_K326_EXPECTED_ANNOTATION_TRACK_TYPES,
  KPHAFFII_GS115_EXPECTED_ANNOTATION_TRACK_TYPES,
  KPHAFFII_CBS7435_EXPECTED_ANNOTATION_TRACK_TYPES,
  CANDIDA_SC5314_EXPECTED_ANNOTATION_TRACK_TYPES,
  ANIDULANS_FGSC_A4_EXPECTED_ANNOTATION_TRACK_TYPES,
  PFALCIPARUM3D7_EXPECTED_ANNOTATION_TRACK_TYPES,
  AGAMBIAE_F1_EXPECTED_ANNOTATION_TRACK_TYPES,
} from './hosted-reference-acceptance-track-rosters-public-data-wave03';

export const IRGSP1_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_001433935.1', // gitleaks:allow
  rawFastaRelativePath: 'irgsp1/GCF_001433935.1/ba06d33642394dfc/GCF_001433935.1_primary.fna',
  rawFastaSha256: 'ba06d33642394dfc88a77a96e7d650cdb360b3e8ad9d3cf054a4295d4b38c4ca',
  rawGff3RelativePath: 'irgsp1/GCF_001433935.1/498dfd39d68633f8/GCF_001433935.1_primary.gff3',
  rawGff3Sha256: '498dfd39d68633f8b497317080e8612ed71844519a0c4018d63d769299562f6e',
  expectedAnnotationTrackTypes: IRGSP1_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/89/894a6a6cad1ae188f3baa3dede3c84cfd775f09bbfa1f18efcdb3fb47b58c5a1',
  preparedManifestSha256: '894a6a6cad1ae188f3baa3dede3c84cfd775f09bbfa1f18efcdb3fb47b58c5a1',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/95/95d2f59723fde8d7339c9ea1055dd29e365ad2915b9bafd6e08ae22b6b96998f',
    sha256: '95d2f59723fde8d7339c9ea1055dd29e365ad2915b9bafd6e08ae22b6b96998f',
  }),
  preparedBundleFingerprint: '6134fe74ca7cc6f776d0083a1c4e937807602118cfd9fc9d7c61a672982ca680',
  firstViewRosterSha256: 'e4bb10921e8831289b44fb698ebe00a55de9c4a0d03368915b4066a412a21474',
});

export const SOYBEAN_V4_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000004515.6', // gitleaks:allow
  rawFastaRelativePath: 'soybeanV4/GCF_000004515.6/9baaed74b5d77891/GCF_000004515.6_primary.fna',
  rawFastaSha256: '9baaed74b5d778914a7e4f164a3459151fe2e6ed551f150c7ccdbfc458469ff3',
  rawGff3RelativePath: 'soybeanV4/GCF_000004515.6/4169bf631a903344/GCF_000004515.6_primary.gff3',
  rawGff3Sha256: '4169bf631a9033448bb72f097125b93f8294b27fc6c4968fb4bcba2dc6c001b6',
  expectedAnnotationTrackTypes: SOYBEAN_V4_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/d3/d3aa917d297bba1048c8e2b93a167f5f74f573789674c136fc85f4698b5b6cea',
  preparedManifestSha256: 'd3aa917d297bba1048c8e2b93a167f5f74f573789674c136fc85f4698b5b6cea',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/2c/2c888ae4e0753e484fdf2c156ef3e55525f59657060ae6cb0085b3d5dddd1d16',
    sha256: '2c888ae4e0753e484fdf2c156ef3e55525f59657060ae6cb0085b3d5dddd1d16',
  }),
  preparedBundleFingerprint: '4e6aa4f4daf3e8020fd173711e923bdabcad628615bd95a6f7ad98072e6a387f',
  firstViewRosterSha256: 'f6431efdbcf731f1c1c0fb3a05127389a5bb26eb605c2caa5072f8064030343b',
});

export const NT_K326_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000715075.1', // gitleaks:allow
  rawFastaRelativePath: 'ntK326/GCF_000715075.1/7dfc36c877c7ad63/GCF_000715075.1_primary.fna',
  rawFastaSha256: '7dfc36c877c7ad631c3bc73cdf990b81a0454843324759b93305d499cbf2445b',
  rawGff3RelativePath: 'ntK326/GCF_000715075.1/bc80ab9e67178421/GCF_000715075.1_primary.gff3',
  rawGff3Sha256: 'bc80ab9e67178421b606ebc063fdfbc00adb5437f24844de00584ac638af1e4a',
  expectedAnnotationTrackTypes: NT_K326_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/c1/c1d44a02153218be246a26e9ccfc1ba1f9083f834c291b2301ccc558ca67799e',
  preparedManifestSha256: 'c1d44a02153218be246a26e9ccfc1ba1f9083f834c291b2301ccc558ca67799e',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/70/7027aa6dbd4a28ea41879871c6453699dd86ea852328e1dcf1ff52bcc4484be5',
    sha256: '7027aa6dbd4a28ea41879871c6453699dd86ea852328e1dcf1ff52bcc4484be5',
  }),
  preparedBundleFingerprint: '3eb3aa17d80b794b7ccf60419e7db5f393f12d39bdb171fccf5380afb9ab14ca',
  firstViewRosterSha256: '0e5b102e9eabc30b5b15fc3b5ffd43f9b6bebeb0a1d7c6d72da145cb71c7bfa3',
});

export const KPHAFFII_GS115_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000027005.1', // gitleaks:allow
  rawFastaRelativePath:
    'kphaffiiGs115/GCF_000027005.1/9dabe7b9a2cb2950/GCF_000027005.1_primary.fna',
  rawFastaSha256: '9dabe7b9a2cb29508806e8e6d946789a39ba803566c0ab07258fd7678602aa60',
  rawGff3RelativePath:
    'kphaffiiGs115/GCF_000027005.1/8c80e79c1ea0e6b7/GCF_000027005.1_primary.gff3',
  rawGff3Sha256: '8c80e79c1ea0e6b7eee50917ba9c886f384bb58dafd1c42869279f46b28ad940',
  expectedAnnotationTrackTypes: KPHAFFII_GS115_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/b0/b05e88c376b6ee3b87ca531a309a561f7445e92b1a8dc46be68ddc0335ec276d',
  preparedManifestSha256: 'b05e88c376b6ee3b87ca531a309a561f7445e92b1a8dc46be68ddc0335ec276d',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/93/93684e32988318d5528b10b0f736e9e7cea944a01cfc0cfd9263f6bfbf38a1a3',
    sha256: '93684e32988318d5528b10b0f736e9e7cea944a01cfc0cfd9263f6bfbf38a1a3',
  }),
  preparedBundleFingerprint: '9b9a9b9bdb20057c50a53e85e0ae33e49abc290c700476faddd3c308fd8e6507',
  firstViewRosterSha256: '85fb6225e8e31455069b351b161cbec14f5f14ed8729e15439b54288862507fc',
});

export const KPHAFFII_CBS7435_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCA_000223565.1', // gitleaks:allow
  rawFastaRelativePath:
    'kphaffiiCbs7435/GCA_000223565.1/5cf77590c9cabb91/GCA_000223565.1_primary.fna',
  rawFastaSha256: '5cf77590c9cabb9114dc6f307f419acb4512b1a0022420119211864533175a7a',
  rawGff3RelativePath:
    'kphaffiiCbs7435/GCA_000223565.1/060a4731feee8913/GCA_000223565.1_primary.gff3',
  rawGff3Sha256: '060a4731feee891344b91841d6c296f20f91ada4ba922c6d716a973661cef67a',
  expectedAnnotationTrackTypes: KPHAFFII_CBS7435_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/7b/7b53b6e1f8e1474a0a87bc825cb9c5be0f8419459fa781ef058ac48bced47373',
  preparedManifestSha256: '7b53b6e1f8e1474a0a87bc825cb9c5be0f8419459fa781ef058ac48bced47373',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/b0/b016f3d1a304ecc9e0163f565b642ab2ec93822022dc79cf0653b5fa925b0829',
    sha256: 'b016f3d1a304ecc9e0163f565b642ab2ec93822022dc79cf0653b5fa925b0829',
  }),
  preparedBundleFingerprint: '7939a821756c6f4aa6e10190dff00f7536c6c66780c032614d1e25f05e199f16',
  firstViewRosterSha256: '7474781ff4100741838dd2d6384cfa93127d669566bd6f27644a073b39f28774',
});

export const CANDIDA_SC5314_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000182965.3', // gitleaks:allow
  rawFastaRelativePath:
    'candidaSC5314/GCF_000182965.3/9f067c1baa920a90/GCF_000182965.3_primary.fna',
  rawFastaSha256: '9f067c1baa920a90179c8addc517bad246b55acac94701b08e13872bb1f65e91',
  rawGff3RelativePath:
    'candidaSC5314/GCF_000182965.3/3fccfccd91632c8c/GCF_000182965.3_primary.gff3',
  rawGff3Sha256: '3fccfccd91632c8c29d61a16924ad0c77e904a3f0c23fe6e87ec62a0fd6e3e04',
  expectedAnnotationTrackTypes: CANDIDA_SC5314_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/dc/dc994abf56b271ce06cb362cf3dc27429bf876214c412efa8e9c08469f4a7519',
  preparedManifestSha256: 'dc994abf56b271ce06cb362cf3dc27429bf876214c412efa8e9c08469f4a7519',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/9a/9a32d4c92ed1e9120e41ba33469da037e8d11a9c898872e0cfecb73181a8f00a',
    sha256: '9a32d4c92ed1e9120e41ba33469da037e8d11a9c898872e0cfecb73181a8f00a',
  }),
  preparedBundleFingerprint: '5b61affb42cf357202a24ca015f5869488be6a590ff5989ad04d721e8b8e1080',
  firstViewRosterSha256: 'db7ebbae0c63f95d02fcf097011be1a64411bf57cc70fb0e41429c7a4dde3ad5',
});

export const ANIDULANS_FGSC_A4_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000011425.1', // gitleaks:allow
  rawFastaRelativePath:
    'anidulansFgscA4/GCF_000011425.1/8d00848bda799b11/GCF_000011425.1_primary.fna',
  rawFastaSha256: '8d00848bda799b113994dec98b27d4ee538113116d773c2941527cabb184152a',
  rawGff3RelativePath:
    'anidulansFgscA4/GCF_000011425.1/d5108868be33b5b9/GCF_000011425.1_primary.gff3',
  rawGff3Sha256: 'd5108868be33b5b90b655a6bf3e65c87b45b68e2d7f1b678b31f47b81504f481',
  expectedAnnotationTrackTypes: ANIDULANS_FGSC_A4_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/6b/6bcb8abc46a74f2a62273cae89f8431f4d450223d77287266dadfceb215741b6',
  preparedManifestSha256: '6bcb8abc46a74f2a62273cae89f8431f4d450223d77287266dadfceb215741b6',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/51/5125d38d260816dfb77c57716cd3c3115438f5a5045dfd87b413000698359a07',
    sha256: '5125d38d260816dfb77c57716cd3c3115438f5a5045dfd87b413000698359a07',
  }),
  preparedBundleFingerprint: '19b762fd30a2d034b80f355820c3c180c7226faae30b83735d6ba74ff2b8bc55',
  firstViewRosterSha256: '59cbca6813d04d14f06626051d5b4e6b221910bb12ef89993255453c7eebd208',
});

export const PFALCIPARUM3D7_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000002765.6', // gitleaks:allow
  rawFastaRelativePath:
    'pfalciparum3d7/GCF_000002765.6/15695198cdb184aa/GCF_000002765.6_primary.fna',
  rawFastaSha256: '15695198cdb184aa99adac2ceb8aee41ef584c43c0fcf9ef772a64b760857ac1',
  rawGff3RelativePath:
    'pfalciparum3d7/GCF_000002765.6/e6750cb2d5f65f75/GCF_000002765.6_primary.gff3',
  rawGff3Sha256: 'e6750cb2d5f65f75c1d4cbded861f3115749f423526077877bf3815c8a8a0865',
  expectedAnnotationTrackTypes: PFALCIPARUM3D7_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/6a/6a0c21c137e21f5ea0a6cc9844df28dfdd7bd18b245fde16b96c9e1c6a1ac5a4',
  preparedManifestSha256: '6a0c21c137e21f5ea0a6cc9844df28dfdd7bd18b245fde16b96c9e1c6a1ac5a4',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/34/34ce2dbabf431705757b2bd52883547c1284753c1fe759236f8b42386e71c816',
    sha256: '34ce2dbabf431705757b2bd52883547c1284753c1fe759236f8b42386e71c816',
  }),
  preparedBundleFingerprint: '83c91ebb72b6aaea7ffe790327f7f6323df3cb8fc9037be0f347e545c0934e46',
  firstViewRosterSha256: '6003ca7dc3bc796fe43722aeccef5fb1d1bd8ad8155e626d7d125baebaf66126',
});

export const AGAMBIAE_F1_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_943734735.2', // gitleaks:allow
  rawFastaRelativePath: 'agambiaeF1/GCF_943734735.2/4dcac7f2ea1f9756/GCF_943734735.2_primary.fna',
  rawFastaSha256: '4dcac7f2ea1f9756c3650623d589bf4f4013cbc8c6db77fd0c5813ec7782ac84',
  rawGff3RelativePath: 'agambiaeF1/GCF_943734735.2/8197468063039888/GCF_943734735.2_primary.gff3',
  rawGff3Sha256: '81974680630398888ba761978b99704681caa1189ee7441929d40ab7a5e09d40',
  expectedAnnotationTrackTypes: AGAMBIAE_F1_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/02/0296a82003f36ea897d3187ebd6efc11329d294dbd4c46ec6deb65b42efd0f0e',
  preparedManifestSha256: '0296a82003f36ea897d3187ebd6efc11329d294dbd4c46ec6deb65b42efd0f0e',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/83/834029ac282ae4c52a7a1837c34794ca3450d884f2b715de3a367376fed9a3af',
    sha256: '834029ac282ae4c52a7a1837c34794ca3450d884f2b715de3a367376fed9a3af',
  }),
  preparedBundleFingerprint: '074adbb9ac53df1822edef3e892c4fb3c755279e53d9075e1bc8f3b54f2deeb2',
  firstViewRosterSha256: '745c7458e0efc197bfdad6e57a1100b1a06a4014e3542e8190ee4899d9f9a069',
});
