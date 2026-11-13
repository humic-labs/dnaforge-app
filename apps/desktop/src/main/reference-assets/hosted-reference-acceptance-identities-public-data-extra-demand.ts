import {
  T2T_MFA8_V11_EXPECTED_ANNOTATION_TRACK_TYPES,
  SBICOLOR_NCBI_V3_EXPECTED_ANNOTATION_TRACK_TYPES,
} from './hosted-reference-acceptance-track-rosters-public-data-extra-demand';

export const T2T_MFA8_V11_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_037993035.2', // gitleaks:allow
  rawFastaRelativePath: 't2tMfa8v11/GCF_037993035.2/6996354eb300bf9c/GCF_037993035.2_primary.fna',
  rawFastaSha256: '6996354eb300bf9c565c5caaf805ef6ae07428244738c1213d4901616e2a8227',
  rawGff3RelativePath: 't2tMfa8v11/GCF_037993035.2/9ab0b2636e2b7136/GCF_037993035.2_primary.gff3',
  rawGff3Sha256: '9ab0b2636e2b71369790ba668cc8e68797fefaa733b71bf45581f22c92358e6b',
  expectedAnnotationTrackTypes: T2T_MFA8_V11_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/30/30a4460c555d713202427310968ed4a4c2883a9d9cd8ef567edecc35f6d9107c',
  preparedManifestSha256: '30a4460c555d713202427310968ed4a4c2883a9d9cd8ef567edecc35f6d9107c',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/61/619328d27e8e06706bfe65fca34239b91b652adcac0180672c969cc6abf8d702',
    sha256: '619328d27e8e06706bfe65fca34239b91b652adcac0180672c969cc6abf8d702',
  }),
  preparedBundleFingerprint: '63acf7a5028ef02711586a7cd4e4400e11d51973bfa10e3ad0c6302d8500b768',
  firstViewRosterSha256: 'a30e2a7dcbdc97f278b5eeb6ff24980e4877b8c3ea70867c160877015bf6bcc5',
});
export const SBICOLOR_NCBI_V3_ACCEPTANCE_IDENTITY = Object.freeze({
  assemblyAccession: 'GCF_000003195.3', // gitleaks:allow
  rawFastaRelativePath:
    'sbicolorNcbiv3/GCF_000003195.3/880b5de6a899b1ef/GCF_000003195.3_primary.fna',
  rawFastaSha256: '880b5de6a899b1ef9419186bfd3fb5f0db65fb65532d95e6a64c552d34642fb7',
  rawGff3RelativePath:
    'sbicolorNcbiv3/GCF_000003195.3/cd373d49408834f2/GCF_000003195.3_primary.gff3',
  rawGff3Sha256: 'cd373d49408834f2345ba24d0a739302d90ba640c6676381b16cf5bf0a1ce8d7',
  expectedAnnotationTrackTypes: SBICOLOR_NCBI_V3_EXPECTED_ANNOTATION_TRACK_TYPES,
  preparedManifestRelativePath:
    'objects/sha256/3e/3eb0b2399867e34591288bb766188fd88e652e786eba87faacd81746b8573f99',
  preparedManifestSha256: '3eb0b2399867e34591288bb766188fd88e652e786eba87faacd81746b8573f99',
  firstViewTransport: Object.freeze({
    kind: 'pack',
    relativePath:
      'objects/sha256/cd/cd88b11e7b01c54ea28e190743bd83901eb6e598391595faf0130303352b3dd7',
    sha256: 'cd88b11e7b01c54ea28e190743bd83901eb6e598391595faf0130303352b3dd7',
  }),
  preparedBundleFingerprint: 'cfc6009dd9fa1dfc2ce0f6b09059e7118e95d5715d1d46477e9c1b8c8e8c297c',
  firstViewRosterSha256: '96655b714f1b2b3f5b623424767ee7c55b8397d18283cfed8cb5e229d2d364f6',
});
