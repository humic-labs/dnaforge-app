import type { LoadPhase } from './indexed-genome-load-phase';

export function indexedGenomeAssemblySourceReady(
  hasAssembly: boolean,
  assemblySourceReadiness: string | undefined
): boolean {
  return !hasAssembly || assemblySourceReadiness !== 'pending';
}

export function indexedGenomeAssemblyAnnotationsNotApplicable(
  hasAssembly: boolean,
  productsReadiness: string | undefined
): boolean {
  return hasAssembly && productsReadiness === 'not-applicable';
}

export function indexedGenomeAssemblyAnnotationProductsReady(
  hasAssembly: boolean,
  productsReadiness: string | undefined
): boolean {
  return (
    !hasAssembly ||
    productsReadiness === undefined ||
    productsReadiness === 'ready' ||
    productsReadiness === 'not-applicable'
  );
}

export function indexedGenomeAssemblyAdmissionReady(args: {
  hasAssembly: boolean;
  assemblyId: string | undefined;
  admissionAssemblyId: string | null;
  admissionStatus: string;
}): boolean {
  return (
    !args.hasAssembly ||
    (args.admissionAssemblyId === args.assemblyId && args.admissionStatus === 'ready')
  );
}

export function indexedGenomeAssemblyIdeogramOnly(
  hasAssembly: boolean,
  assemblySourceReady: boolean
): boolean {
  return hasAssembly && !assemblySourceReady;
}

export function indexedGenomeLoadingOverlayPhase(
  loadPhase: LoadPhase,
  allowTrackOnlyInteraction: boolean
): Exclude<LoadPhase, 'ready'> | null {
  if (loadPhase === 'ready') return null;
  if (loadPhase === 'loading-data' && allowTrackOnlyInteraction) return null;
  return loadPhase;
}

export function indexedGenomeViewerPresentationOwnerKey(
  assemblyId: string | undefined,
  genomeOpenSourcePath: string
): string {
  return assemblyId ? `assembly:${assemblyId}` : genomeOpenSourcePath;
}

export function indexedGenomeAxisLength<T>(
  assembly: T | null | undefined,
  assemblyTotalLength: (assembly: T) => number,
  metadataLength: number | undefined,
  manifestLength: number | undefined
): number {
  if (assembly) return assemblyTotalLength(assembly);
  return metadataLength ?? manifestLength ?? 0;
}

export function indexedGenomeLaneAssemblyId(
  assemblyId: string | undefined,
  manifestChrom: string | undefined,
  sourceChrom: string
): string {
  return assemblyId ?? manifestChrom ?? sourceChrom;
}

export function indexedGenomeDisplayedViewportRange(
  liveViewportRange: { start: number; end: number } | null,
  rangeStart: number,
  rangeEnd: number
): { start: number; end: number } {
  return liveViewportRange ?? { start: rangeStart, end: rangeEnd };
}

export function indexedGenomeRangeEnd(
  length: number,
  rangeStart: number,
  windowSize: number
): number {
  return length > 0 ? Math.min(length, rangeStart + windowSize) : rangeStart + windowSize;
}

export function indexedGenomeThemeMode(darkMode: boolean): 'dark' | 'light' {
  return darkMode ? 'dark' : 'light';
}

export function firstPresent<T>(
  primary: T | null | undefined,
  secondary: T | null | undefined,
  fallback: T
): T {
  return primary ?? secondary ?? fallback;
}

export function indexedGenomePrepareLoadPhase(hasManifest: boolean): 'opening' | 'indexing' {
  return hasManifest ? 'opening' : 'indexing';
}

export function indexedGenomeOpenSourceSizeBytes(
  hasAssembly: boolean,
  fileSizeBytes: number | undefined
): number | undefined {
  return hasAssembly ? undefined : fileSizeBytes;
}

export function indexedGenomeFullAssemblyReadinessRequired(
  assemblyAnnotationProductsReady: boolean,
  assemblyTextureSourceRequest: unknown
): boolean {
  return assemblyAnnotationProductsReady && assemblyTextureSourceRequest !== null;
}

export function indexedGenomeVisibleHostedBackgroundPreparation<T extends { status: string }>(
  hosted: T,
  idleProjection: T
): T {
  return hosted.status === 'idle' ? idleProjection : hosted;
}

export function indexedGenomeTabViewerGate(args: {
  chrom: string | undefined;
  manifestChrom: string | undefined;
  sourceChrom: string;
  hasManifest: boolean;
  length: number;
  loadPhase: string;
  assemblySourceReady: boolean;
  assemblyAdmissionReady: boolean;
  hasAssembly: boolean;
  sessionSearchReadiness: string | undefined;
  indexedSearchReadiness: string | undefined;
  sessionSearchSourceDefined: boolean;
}): {
  visualChrom: string;
  displayedChrom: string;
  canShowViewer: boolean;
  canNavigate: boolean;
  sequenceSearchReady: boolean;
  assemblyAnnotationSearchNotApplicable: boolean;
  assemblyAnnotationSearchReady: boolean;
} {
  const visualChrom = args.chrom ?? args.manifestChrom ?? args.sourceChrom;
  const displayedChrom = args.chrom ?? args.manifestChrom ?? visualChrom;
  const canShowViewer = Boolean(args.hasManifest && args.length > 0);
  const canNavigate = canShowViewer && args.loadPhase === 'ready';
  const sequenceSearchReady =
    canNavigate && args.assemblySourceReady && args.assemblyAdmissionReady;
  const assemblyAnnotationSearchNotApplicable =
    args.hasAssembly &&
    (args.sessionSearchReadiness === 'not-applicable' ||
      args.indexedSearchReadiness === 'not-applicable');
  const assemblyAnnotationSearchReady =
    !args.hasAssembly ||
    args.sessionSearchReadiness === 'ready' ||
    (args.sessionSearchReadiness === undefined && args.sessionSearchSourceDefined);
  return {
    visualChrom,
    displayedChrom,
    canShowViewer,
    canNavigate,
    sequenceSearchReady,
    assemblyAnnotationSearchNotApplicable,
    assemblyAnnotationSearchReady,
  };
}

export function indexedGenomeAdmittedAnnotationSceneRequest<T extends { assemblyId?: string }>(
  sessionSource: T | null | undefined,
  indexedSource: T | null | undefined
): T | null {
  return sessionSource ?? indexedSource ?? null;
}

export function indexedGenomeViewerAnnotationSceneRequest<T extends { assemblyId?: string }>(
  admitted: T | null,
  assemblyId: string | undefined,
  complete: T | null
): T | null {
  return admitted?.assemblyId === assemblyId ? admitted : complete;
}

export function indexedGenomeSearchSources<TIndex, TAnnotation, TSequence>(args: {
  completeAssemblyRequest: unknown;
  annotationIndex: TIndex;
  isActive: boolean;
  assemblySearchSource: TAnnotation | null | undefined;
  assemblySequenceSearchSource: TSequence | null;
}): {
  annotationIndex: TIndex | null;
  assemblyAnnotationSearchSource: TAnnotation | null;
  assemblySequenceSearchSource: TSequence | null;
} {
  return {
    annotationIndex: args.completeAssemblyRequest ? null : args.annotationIndex,
    assemblyAnnotationSearchSource: args.isActive ? (args.assemblySearchSource ?? null) : null,
    assemblySequenceSearchSource: args.isActive ? args.assemblySequenceSearchSource : null,
  };
}
