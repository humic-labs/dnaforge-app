// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  firstPresent,
  indexedGenomeAssemblyAdmissionReady,
  indexedGenomeAssemblyAnnotationProductsReady,
  indexedGenomeAssemblyAnnotationsNotApplicable,
  indexedGenomeAssemblyIdeogramOnly,
  indexedGenomeAssemblySourceReady,
  indexedGenomeAxisLength,
  indexedGenomeDisplayedViewportRange,
  indexedGenomeLaneAssemblyId,
  indexedGenomeLoadingOverlayPhase,
  indexedGenomeRangeEnd,
  indexedGenomeAdmittedAnnotationSceneRequest,
  indexedGenomeTabViewerGate,
  indexedGenomeThemeMode,
  indexedGenomeViewerAnnotationSceneRequest,
  indexedGenomeViewerPresentationOwnerKey,
} from './indexed-genome-tab-readiness';

describe('indexed genome tab readiness', () => {
  it('treats missing readiness as source-ready for a legacy persisted assembly', () => {
    expect(indexedGenomeAssemblySourceReady(true, undefined)).toBe(true);
    expect(indexedGenomeAssemblySourceReady(true, 'pending')).toBe(false);
    expect(indexedGenomeAssemblySourceReady(false, 'pending')).toBe(true);
  });

  it('treats annotation products ready when absent, ready, or not-applicable', () => {
    expect(indexedGenomeAssemblyAnnotationProductsReady(true, undefined)).toBe(true);
    expect(indexedGenomeAssemblyAnnotationProductsReady(true, 'ready')).toBe(true);
    expect(indexedGenomeAssemblyAnnotationProductsReady(true, 'not-applicable')).toBe(true);
    expect(indexedGenomeAssemblyAnnotationProductsReady(true, 'pending')).toBe(false);
    expect(indexedGenomeAssemblyAnnotationsNotApplicable(true, 'not-applicable')).toBe(true);
  });

  it('admits the coordinate shell once this assembly id is ready', () => {
    expect(
      indexedGenomeAssemblyAdmissionReady({
        hasAssembly: true,
        assemblyId: 'GRCh38',
        admissionAssemblyId: 'GRCh38',
        admissionStatus: 'ready',
      })
    ).toBe(true);
    expect(
      indexedGenomeAssemblyAdmissionReady({
        hasAssembly: true,
        assemblyId: 'GRCh38',
        admissionAssemblyId: 'GRCh38',
        admissionStatus: 'checking',
      })
    ).toBe(false);
  });

  it('shows the ideogram-only shell while source admission is still pending', () => {
    expect(indexedGenomeAssemblyIdeogramOnly(true, false)).toBe(true);
    expect(indexedGenomeAssemblyIdeogramOnly(true, true)).toBe(false);
  });

  it('keeps a track-only assembly interactive while its optional reference source is pending', () => {
    expect(indexedGenomeLoadingOverlayPhase('loading-data', true)).toBeNull();
    expect(indexedGenomeLoadingOverlayPhase('loading-data', false)).toBe('loading-data');
    expect(indexedGenomeLoadingOverlayPhase('opening', true)).toBe('opening');
    expect(indexedGenomeLoadingOverlayPhase('error', true)).toBe('error');
    expect(indexedGenomeLoadingOverlayPhase('ready', false)).toBeNull();
  });
});

describe('indexed genome tab identity', () => {
  it('keys the viewer owner on the assembly id, else the real source path', () => {
    expect(indexedGenomeViewerPresentationOwnerKey('GRCh38', '/tmp/x.fa')).toBe('assembly:GRCh38');
    expect(indexedGenomeViewerPresentationOwnerKey(undefined, '/tmp/x.fa')).toBe('/tmp/x.fa');
  });

  it('uses the full assembly axis length, not the anchor chromosome', () => {
    expect(indexedGenomeAxisLength({ id: 'a' }, () => 3_088_269_832, 100, 100)).toBe(3_088_269_832);
    expect(indexedGenomeAxisLength(null, () => 3_088_269_832, undefined, 78_000)).toBe(78_000);
  });

  it('prefers assembly id, then manifest chrom, then the file stem', () => {
    expect(indexedGenomeLaneAssemblyId('GRCh38', 'chr1', 'file')).toBe('GRCh38');
    expect(indexedGenomeLaneAssemblyId(undefined, 'chr1', 'file')).toBe('chr1');
    expect(indexedGenomeLaneAssemblyId(undefined, undefined, 'file')).toBe('file');
  });

  it('keeps the live viewport when present and otherwise uses the window', () => {
    expect(indexedGenomeRangeEnd(1000, 100, 50)).toBe(150);
    expect(indexedGenomeRangeEnd(0, 100, 50)).toBe(150);
    expect(indexedGenomeDisplayedViewportRange({ start: 10, end: 20 }, 0, 50)).toEqual({
      start: 10,
      end: 20,
    });
    expect(indexedGenomeDisplayedViewportRange(null, 0, 50)).toEqual({ start: 0, end: 50 });
  });

  it('maps dark mode to the viewer theme string', () => {
    expect(indexedGenomeThemeMode(true)).toBe('dark');
    expect(indexedGenomeThemeMode(false)).toBe('light');
  });

  it('coalesces the first present identity', () => {
    expect(firstPresent(null, 'b', 'c')).toBe('b');
    expect(firstPresent(undefined, undefined, 'c')).toBe('c');
  });

  it('uses the session-admitted search source when it matches this assembly', () => {
    const admitted = indexedGenomeAdmittedAnnotationSceneRequest(
      { assemblyId: 'GRCh38' },
      { assemblyId: 'other' }
    );
    expect(admitted?.assemblyId).toBe('GRCh38');
    expect(
      indexedGenomeViewerAnnotationSceneRequest(admitted, 'GRCh38', { assemblyId: 'complete' })
        ?.assemblyId
    ).toBe('GRCh38');
    expect(
      indexedGenomeViewerAnnotationSceneRequest(admitted, 'HG002', { assemblyId: 'complete' })
        ?.assemblyId
    ).toBe('complete');
  });
});

describe('indexedGenomeTabViewerGate', () => {
  it('mounts the coordinate shell from a persisted manifest even before admission is ready', () => {
    const gated = indexedGenomeTabViewerGate({
      chrom: undefined,
      manifestChrom: 'chr11',
      sourceChrom: 'file',
      hasManifest: true,
      length: 1000,
      loadPhase: 'loading',
      assemblySourceReady: false,
      assemblyAdmissionReady: false,
      hasAssembly: true,
      sessionSearchReadiness: undefined,
      indexedSearchReadiness: undefined,
      sessionSearchSourceDefined: false,
    });
    expect(gated.canShowViewer).toBe(true);
    expect(gated.canNavigate).toBe(false);
    expect(gated.sequenceSearchReady).toBe(false);
    expect(gated.displayedChrom).toBe('chr11');
  });

  it('treats assembly annotation search as ready once the session source is published', () => {
    const gated = indexedGenomeTabViewerGate({
      chrom: 'chr11',
      manifestChrom: 'chr11',
      sourceChrom: 'file',
      hasManifest: true,
      length: 1000,
      loadPhase: 'ready',
      assemblySourceReady: true,
      assemblyAdmissionReady: true,
      hasAssembly: true,
      sessionSearchReadiness: undefined,
      indexedSearchReadiness: undefined,
      sessionSearchSourceDefined: true,
    });
    expect(gated.sequenceSearchReady).toBe(true);
    expect(gated.assemblyAnnotationSearchReady).toBe(true);
  });
});
