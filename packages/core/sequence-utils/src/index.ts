export {
  BASE_COLORS,
  NUCLEOTIDE_COLORS,
  ANNOTATION_COLORS,
  MUTATION_COLORS,
  ANNOTATION_PALETTES,
  getBaseColor,
  getNucleotideColors,
  getAnnotationColor,
  getFeatureColor,
  FEATURE_COLORS,
  getAvailablePaletteIds,
  getPalette,
  setActivePalette,
  getActivePaletteId,
  AA_COLOR_SCHEMES,
  getAAScheme,
  getAAColor,
  type NucleotideBase,
  type AnnotationType,
  type MutationType,
  type AnnotationColorPalette,
  type AminoAcidColorScheme,
} from './colors';

export {
  assemblyScaffoldTooltip,
  createAssemblyScaffoldLayout,
  assemblyScaffoldRulerTicks,
  assemblyScaffoldSelectionLength,
  type AssemblyScaffold,
  type AssemblyScaffoldLayout,
} from './assembly-scaffold';
export {
  applySequenceStrandOverrides,
  sequenceStrandOverrideAt,
  type SequenceStrandOverride,
} from './sequence-strand-display';

export {
  ANNOTATION_COLOR_MODES,
  ANNOTATION_DISPLAY_COLOR_OPTIONS,
  DEFAULT_ANNOTATION_COLOR_MODE,
  normalizeAnnotationColorMode,
  resolveAnnotationDisplayColor,
  resolveAnnotationDisplayStyle,
  type AnnotationColorFacts,
  type AnnotationColorMode,
  type AnnotationColorSource,
  type AnnotationDisplayColorOption,
  type AnnotationDisplayContext,
  type AnnotationDisplayProfile,
  type AnnotationDisplayStyle,
} from './annotation-display';

export { inferFeatureTypeFromLabel } from './annotation-type-inference';

export {
  featureAliases,
  resolveFeaturesByName,
  type FeatureIdentityInput,
  type FeatureAliasSet,
  type FeatureXref,
  type AliasMatch,
  type AliasMatchKind,
  type ResolveFeaturesOptions,
} from './feature-aliases';

export type {
  Annotation,
  AnnotationDirection,
  AnnotationLayer,
  AnnotatedSequence,
  Mutation,
  MutationCategory,
  MutationClassification,
  MutationTypeString,
  Reference,
  SequenceSelection,
  ViewportBounds,
} from './types';

export {
  attachSequenceDocumentMetadata,
  decodeSequenceDocument,
  getSequenceDocumentMetadata,
  getSequenceFormatCapabilities,
  getSequenceSavePolicy,
  sequenceFormatFromFilename,
  serializeSequenceForInPlaceSave,
  type DecodeSequenceDocumentOptions,
  type SequenceDocument,
  type SequenceDocumentCapabilities,
  type SequenceDocumentContent,
  type SequenceDocumentMetadata,
  type SequenceDocumentMetadataKey,
  type SequenceDocumentSource,
} from './sequence-document';

export {
  IUPAC_COMPLEMENT,
  IUPAC_RNA_COMPLEMENT,
  complementTable,
  toNucleicAcid,
  type NucleicAcid,
  IUPAC_EXPANSION,
  IUPAC_REGEX_CLASS,
  IUPAC_DEGENERACY,
  DNA_ALPHABET,
  DEFAULT_MAX_EXPANSION,
  complementBase,
  isDegenerateBase,
  containsDegenerateBases,
  expandDegenerateSequence,
} from './iupac';

export { normalizePlainDnaClipboardText } from './clipboard';

export {
  deriveSequenceEditTransition,
  SequenceEditTransitionError,
  type DeriveSequenceEditTransitionInput,
  type SequenceEditMarkerRange,
  type SequenceEditSubstitutionRange,
  type SequenceEditTransition,
  type SequenceEditTransitionOperation,
} from './sequence-edit-transition';

export {
  adjustAnnotationsForInsert,
  adjustAnnotationsForDelete,
  mapAnnotationThroughSequenceEditTransition,
  type AnnotationCoordinateMapping,
} from './annotation-coordinate-edit';

export {
  projectCodingSequence,
  isSplicedCDS,
  codingFrameOffset,
  type CodingFeature,
  type CodingSequence,
  type CodingSequenceContext,
} from './coding-sequence';

export {
  CODON_TABLE,
  AMINO_ACID_NAMES,
  translateCodon,
  getAminoAcidName,
  complement,
  reverseComplement,
  translateSequence,
  cdsToProtein,
  cdsToProteinSpliced,
  isStartCodon,
  isStopCodon,
  isFullCDS,
  areInFrame,
} from './translation';

export {
  GENETIC_CODES,
  STANDARD_GENETIC_CODE,
  STANDARD_GENETIC_CODE_ID,
  geneticCodeLabel,
  geneticCodesAssignIdenticalAminoAcids,
  getGeneticCode,
  isCodingFeature,
  isKnownGeneticCodeId,
  parseTranslTableQualifier,
  resolveAnnotationGeneticCode,
  type RecordGeneticCodeBasis,
  resolveGeneticCode,
  resolveSequenceGeneticCode,
  GENETIC_CODE_CODONS,
  geneticCodeKey,
  isCustomGeneticCodeSpec,
  type CustomGeneticCode,
  type GeneticCode,
  type GeneticCodeBasis,
  type GeneticCodeInput,
  type GeneticCodeSpec,
  type PublishedGeneticCode,
  type SequenceGeneticCodeResolution,
} from './genetic-codes';
export {
  CUSTOM_GENETIC_CODE_NAME_MAX_LENGTH,
  NON_STANDARD_RESIDUE_NAME_MAX_LENGTH,
  STANDARD_AMINO_ACID_LETTERS,
  buildCustomGeneticCode,
  codonDisplay,
  codonLabelThatFits,
  codonMeaning,
  codonResidue,
  nonStandardResidueColor,
  UNNAMED_RESIDUE_COLOR,
  nonStandardResidueLegend,
  validateCustomGeneticCode,
  type BuildCustomGeneticCodeInput,
  type BuildCustomGeneticCodeResult,
  type CodonDisplay,
  type CodonLabelFit,
  type CodonMeaning,
  type CustomGeneticCodeDefinition,
  type CustomGeneticCodeIssue,
  type NonStandardResidue,
  type StandardAminoAcidLetter,
} from './custom-genetic-codes';
export {
  GENBANK_GENETIC_CODE_COMMENT_PREFIX,
  formatGenBankGeneticCodeLines,
  isGenBankGeneticCodeLine,
  readGenBankGeneticCode,
  updateGenBankGeneticCodeComment,
  type GenBankGeneticCodeReading,
} from './genbank-genetic-code';

export {
  codonPositionOf,
  codonReaderFor,
  readCodon,
  type CodonContext,
  type CodonQualifiers,
  type CodonReading,
} from './codon-reading';
export {
  codonExceptionDisplay,
  codonExceptionsOf,
  formatTranslExcept,
  parseTranslExcept,
  residueAbbreviationFromNote,
  withTranslExcept,
  residueNameFromNote,
  translExceptsOf,
  type TranslExcept,
  type TranslExceptAmino,
  type TranslExceptLocation,
  type CodonException,
} from './transl-except';
export {
  INSDC_MODIFIED_AMINO_ACIDS,
  INSDC_STANDARD_AMINO_ACIDS,
  type InsdcModifiedAminoAcid,
  type InsdcStandardAminoAcid,
} from './insdc-amino-acids.generated';

export {
  BACKTRANSLATE_HOST_LABELS,
  CODON_USAGE_TABLES,
  SUPPORTED_BACKTRANSLATE_HOSTS,
  isSupportedBacktranslateHost,
  type CodonUsageEntry,
  type CodonUsageTable,
  type SupportedBacktranslateHost,
} from './codon-usage-tables';
export {
  backtranslate,
  InvalidAminoAcidResidueError,
  UnsupportedBacktranslateHostError,
} from './backtranslate';

export { layoutAnnotations, getVisibleAnnotations, getAnnotationsAtPosition } from './layout';

export * from './restriction-enzymes';

export {
  parseSequenceFile,
  parseSequenceFileSingle,
  detectFormat,
  formatToExtension,
  formatToMimeType,
  parseAb1,
  isAb1Format,
  parseSeq,
  isSeqFormat,
  parseFastq,
  parseFastqSingle,
  isFastqFormat,
  averageQuality,
  parseSnapGene,
  parseSnapGeneSequence,
  isSnapGeneFormat,
  SequenceParseError,
  parseGenBankFull,
  parseGenBankRecords,
  indexGenBankRecords,
  parseFeatureLocation,
  applyComplementOriginWrap,
  extractRawSequence,
  isGenBankFormat,
  GenBankParseError,
  dispatchRouteFor,
  PARSER_DISPATCH_LIMITS,
  planSplitCDSMerges,
  type IndexedGenBankRecord,
  type ParsedSequence,
  type SequenceFormat,
  type ParseOptions,
  type Ab1Metadata,
  type FastqMetadata,
  type SeqMetadata,
  type TraceData,
  type FeatureLocation,
  type ParserDispatchStat,
  type ParserRoute,
  type MergeCandidate,
} from './parsers';

export {
  SIDECAR_VERSION,
  SIDECAR_EXTENSION,
  getSidecarPath,
  isSidecarPath,
  getSourcePath,
  serializeSidecar,
  parseSidecar,
  computeChecksum,
  matchesSequenceChecksumIgnoringCase,
  verifyChecksum,
  createRelativePath,
  resolveRelativePath,
  createVerificationResult,
  summarizeVerification,
  type SidecarType,
  type VerificationStatus,
  type VerificationReference,
  type VerificationResultSummary,
  type VerificationMutation,
  type VerificationAlignment,
  type VerificationInput,
  type VerificationResult,
  type VerificationOptions,
  type MatchCriteria,
  type ReferenceMatch,
  type BatchVerificationInput,
  type BatchVerificationResult,
  type VerificationSummary,
} from './verification';

export {
  formatGenBankLocusPrefix,
  decodeGenBankLocusName,
  GENBANK_LOCUS_ENCODING_COMMENT,
} from './genbank-locus';
export { formatOrigin, formatFeature, formatFeatures, serializeGenBank } from './writers';
export {
  MANAGED_GENBANK_ANNOTATION_ID_QUALIFIER,
  ensureManagedGenBankAnnotationIds,
  listManagedGenBankAnnotations,
  managedGenBankAnnotationValueDigest,
  replaceManagedGenBankAnnotation,
  insertManagedGenBankAnnotation,
  removeManagedGenBankAnnotation,
  type ManagedGenBankAnnotation,
  type ManagedGenBankAnnotationTransfer,
  type ManagedGenBankAnnotationValueDigest,
} from './managed-genbank-annotations';

export {
  cdsEndsInStopCodon,
  cdsStartsOnStartCodon,
  extendCdsFivePrime,
  extendCdsThreePrime,
  type CdsExtension,
  type CdsExtensionDirection,
  type CdsExtensionInput,
} from './cds-extension';
export {
  isStartCodonForGeneticCode,
  isStopCodonForGeneticCode,
  startCodonsForGeneticCode,
  stopCodonsForGeneticCode,
  type GeneticCodeId,
} from './start-codons';
export { findORFs, type ORF } from './orf-detection';

export { searchAnnotations } from './annotation-search';
export {
  expandIUPACToRegex,
  estimateNucleotideSearchMatchCount,
  searchNucleotide,
  searchAnnotationsAndProtein,
  SearchTooBroadError,
  type SearchMatch,
} from './sequence-search';

export {
  classifyMutation,
  classifyMutations,
  type Mutation as AlignmentMutation,
  type FunctionalImpact,
  type ClassifiedMutation,
} from './mutation-classifier';
export {
  classifyMoleculeType,
  isRnaMolecule,
  nucleicAcidOf,
  nucleicAcidOfBases,
  MIN_CLASSIFIABLE_RESIDUES,
  parseGenBankMoleculeLabel,
  MIN_NUCLEOTIDE_CORE_FRACTION,
  type AmbiguousMoleculeReason,
  type MoleculeType,
  type MoleculeTypeClassification,
} from './molecule-type';

export { indexOfSubsequenceBmh, normalizeProteinSearchQuery } from './protein-search';
export { normalizeProteinSequence, proteinSequenceValidationError } from './protein-sequence';
